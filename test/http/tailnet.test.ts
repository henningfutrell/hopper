// This host's tailnet (issue #1024): its MagicDNS name and addresses, read from tailscaled's local API on its socket,
// else from the Tailscale interface's addresses; read again on an interval.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { interfaceAddresses, selfOf, tailscaleSource, watchTailnet, type TailnetSelf } from '../../src/http/tailnet.ts';

const status = { BackendState: 'Running', Self: { DNSName: 'Box.example.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] } };

describe('selfOf', () => {
  it('answers the MagicDNS name, its first label and the tailnet addresses of a running tailscaled', () => {
    expect(selfOf(status)).toEqual({ names: ['box.example.ts.net', 'box'], addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'] });
  });

  it('answers nothing when tailscaled is not running, or says nothing of this host', () => {
    expect(selfOf({ ...status, BackendState: 'Stopped' })).toBeUndefined();
    expect(selfOf({ BackendState: 'Running' })).toBeUndefined();
    expect(selfOf({ BackendState: 'Running', Self: {} })).toBeUndefined();
    expect(selfOf(null)).toBeUndefined();
  });
});

describe('interfaceAddresses', () => {
  it('reads only the tailnet addresses on a Tailscale interface', () => {
    const at = (address: string) => ({ address, netmask: '', family: 'IPv4', mac: '', internal: false, cidr: null }) as const;
    expect(interfaceAddresses({
      tailscale0: [at('100.101.102.103'), at('fd7a:115c:a1e0::1'), at('fe80::1')],
      eth0: [at('192.0.2.5'), at('100.64.0.9')],
    })).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1']);
  });
});

describe('tailscaleSource', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it('asks tailscaled\'s local API on its socket', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'ts-')), 'tailscaled.sock');
    const asked: string[] = [];
    server = createServer((req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers.host}`);
      res.setHeader('content-type', 'application/json').end(JSON.stringify(status));
    });
    await new Promise<void>((done) => server!.listen(socket, done));
    expect(await tailscaleSource({ sockets: [join(tmpdir(), 'none.sock'), socket], files: [], interfaces: () => ({}) })()).toEqual(selfOf(status));
    expect(asked).toEqual(['GET /localapi/v0/status local-tailscaled.sock']);
  });

  it('reads the status file the host wrote for a container, when no socket answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'));
    const file = join(dir, 'status.json'), empty = join(dir, 'empty.json');
    writeFileSync(file, JSON.stringify(status));
    writeFileSync(empty, '');
    const o = { sockets: [join(dir, 'none.sock')], interfaces: () => ({}) };
    expect(await tailscaleSource({ ...o, files: [join(dir, 'none.json'), empty, file] })()).toEqual(selfOf(status));
    // Empty: the host has no tailnet, or no tailscale, or the container has /dev/null mounted there.
    expect(await tailscaleSource({ ...o, files: [empty, '/dev/null'] })()).toBeUndefined();
  });

  it('throws on a status file it cannot parse: the host writes it in place, and a read can see half of it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ts-')), 'status.json');
    writeFileSync(file, '{"BackendState":"Run');
    await expect(tailscaleSource({ sockets: [], files: [file], interfaces: () => ({}) })()).rejects.toThrow();
  });
});

describe('watchTailnet', () => {
  it('reads at the start and again on refresh, and is off while there is no tailnet', async () => {
    let next: TailnetSelf | undefined = { names: ['box.example.ts.net'], addresses: ['100.101.102.103'] };
    const lines: string[] = [];
    const t = watchTailnet({ source: async () => next, logger: { info: (l) => lines.push(l) } });
    await t.refresh();
    expect(t.on()).toBe(true);
    expect(t.names()).toEqual(['box.example.ts.net', '100.101.102.103']);
    next = undefined;
    await t.refresh();
    expect(t.on()).toBe(false);
    expect(t.names()).toEqual([]);
    expect(lines).toEqual(['hopper: on a tailnet: the UI also answers to box.example.ts.net, 100.101.102.103', 'hopper: not on a tailnet']);
    t.stop();
  });

  it('keeps the last read when the source throws', async () => {
    let next: () => Promise<TailnetSelf | undefined> = async () => ({ names: ['box.example.ts.net'], addresses: [] });
    const t = watchTailnet({ source: () => next(), logger: { info: () => undefined } });
    await t.refresh();
    next = async () => { throw new Error('half a file'); };
    await t.refresh();
    expect(t.names()).toEqual(['box.example.ts.net']);
    t.stop();
  });
});
