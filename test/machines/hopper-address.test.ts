// Issue #698: an ssh target was given the hopper's first LAN name, a name only the compose network resolves. Its job
// could not reach the hopper, so it had no GitHub proxy and fell back to a device sign-in. Now the probe asks the
// machine itself which of the hopper's addresses it reaches, and a job there is given that one, or none.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { hopperAddresses, jobHopperUrl, ADDRESS_PATH, addressCommand, networkFix, readAddress } from '../../src/machines/hopper-address.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

/** A server on loopback that answers `status` at the address path. */
async function answering(status: number): Promise<string> {
  const s = createServer((req, res) => { res.statusCode = req.url === ADDRESS_PATH ? status : 404; res.end(); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Runs the address check as a machine's shell would; the servers answer meanwhile. */
const run = (urls: string[], path = process.env.PATH ?? ''): Promise<string> => new Promise((resolve, reject) => {
  execFile('/bin/sh', ['-c', addressCommand(urls)], { encoding: 'utf8', env: { PATH: path } }, (e, out) => (e ? reject(e) : resolve(out)));
});

const base: MachineSnapshot = { id: 'm', label: 'm', maxLanes: 1, online: true, executors: ['herdr-claude'] };

describe('the hopper\'s addresses', () => {
  it('are the public URL, then each LAN name with the port', () => {
    expect(hopperAddresses({ publicUrl: 'https://hopper.example.com', lanNames: ['hopper', 'box.local'], port: 4790 }))
      .toEqual(['https://hopper.example.com', 'http://hopper:4790', 'http://box.local:4790']);
    expect(hopperAddresses({ lanNames: [], port: 4790 })).toEqual([]);
  });
});

describe('the address check on a machine', () => {
  it('finds the first address the machine reaches the hopper at', async () => {
    const good = await answering(204);
    const urls = ['http://127.0.0.1:1', good];
    expect(readAddress(await run(urls), urls)).toEqual({ hopperUrl: good });
  });

  it('none reached: says which addresses failed and why, and what to set', async () => {
    const refused = await answering(403);
    const urls = ['http://127.0.0.1:1', refused];
    const r = readAddress(await run(urls), urls);
    expect(r).toEqual({ addressProblem: expect.stringContaining('the hopper cannot be reached from it: http://127.0.0.1:1 (no connection); ') });
    expect('addressProblem' in r && r.addressProblem).toContain(`${refused} (refused: its address is not in HOPPER_LAN_PEERS)`);
    expect('addressProblem' in r && r.addressProblem).toContain('HOPPER_PUBLIC_URL');
  });

  it('another server at the address is not the hopper', async () => {
    const other = await answering(200);
    const urls = [other];
    expect(readAddress(await run(urls), urls)).toEqual({ addressProblem: expect.stringContaining(`${other} (answered 200, not as the hopper)`) });
  });

  it('a machine without curl: says so', async () => {
    const urls = ['http://127.0.0.1:1'];
    expect(readAddress(await run(urls, '/nonexistent'), urls)).toEqual({ addressProblem: 'curl is not installed there: its jobs cannot reach the hopper' });
  });

  it('a hopper with no address: says what to set', async () => {
    expect(readAddress(await run([]), [])).toEqual({ addressProblem: expect.stringMatching(/^the hopper has no address a machine can reach it at: set HOPPER_PUBLIC_URL/) });
  });

  it('an address is quoted for the shell', () => {
    expect(addressCommand(["http://a'b:1"])).toContain("'http://a'\\''b:1'");
  });
});

describe('the URL a job is given', () => {
  const o = { port: 4790, reachable: 'http://hopper:4790' };
  it('a client target: where it dialled in', () => {
    expect(jobHopperUrl({ ...base, client: {} }, 'https://dialled.example', o)).toBe('https://dialled.example');
  });
  it('this machine: loopback', () => {
    expect(jobHopperUrl(base, undefined, o)).toBe('http://127.0.0.1:4790');
  });
  it('an ssh target: the address its probe found it reaches, else none — never one it cannot', () => {
    expect(jobHopperUrl({ ...base, ssh: 'box', hopperUrl: 'http://10.0.0.2:4790' }, undefined, o)).toBe('http://10.0.0.2:4790');
    expect(jobHopperUrl({ ...base, ssh: 'box', addressProblem: 'x' }, undefined, o)).toBeUndefined();
    expect(jobHopperUrl({ ...base, ssh: 'box' }, undefined, o)).toBeUndefined();
  });
  it('a container target: the public URL, else the first LAN name', () => {
    expect(jobHopperUrl({ ...base, docker: 'c' }, undefined, o)).toBe('http://hopper:4790');
  });
});

// Issue #711: a machine off the hopper's network is flagged with the command that joins it to the network.
describe('the fix for a machine off the hopper\'s network', () => {
  it('an ssh target named by its container name: connect that container to the hopper\'s network', () => {
    expect(networkFix('agent@hopper-box-claude', 'hopper_default')).toBe('podman network connect hopper_default hopper-box-claude');
    expect(networkFix('seat-1', 'hopper_default')).toBe('podman network connect hopper_default seat-1');
  });

  it('a host name or an address is not a container: no network command', () => {
    expect(networkFix('you@host.containers.internal', 'hopper_default')).toBeUndefined();
    expect(networkFix('laptop.local', 'hopper_default')).toBeUndefined();
    expect(networkFix('10.0.0.5', 'hopper_default')).toBeUndefined();
    expect(networkFix('localhost', 'hopper_default')).toBeUndefined();
  });

  it('a hopper on the host network, or of no network: no network command', () => {
    expect(networkFix('agent@hopper-box-claude', 'host')).toBeUndefined();
    expect(networkFix('agent@hopper-box-claude', undefined)).toBeUndefined();
  });
});
