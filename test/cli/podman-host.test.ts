// Issue #2272: `hopper machine podman-host` as calls on the daemon, against a fake of it. Add with no --host-key only
// reads the host's key and says how to pin it; with --host-key it posts the whole list with the new host, against the
// version read; remove posts the list without it. A name taken, a name not there and a bad flag are refusals.
import { describe, expect, it } from 'vitest';
import { OperatorRefusal, perform, type Getter } from '../../src/cli-operator-call.ts';
import { machineCall } from '../../src/cli-operator-machine.ts';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST = { name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY };

function daemon() {
  const posts: { path: string; body: unknown }[] = [];
  const send: Getter = async (path, body) => {
    if (body !== undefined) posts.push({ path, body });
    if (path === '/api/podman-hosts') return { hosts: [HOST], version: 'v1' };
    if (path === '/ui/api/machines/host-key') return { ssh: (body as { ssh: string }).ssh, hostKey: KEY, fingerprint: 'SHA256:abc', known: false };
    if (path === '/ui/api/podman-hosts') return { hosts: (body as { hosts: unknown[] }).hosts, version: 'v2' };
    throw new Error(`no route ${path}`);
  };
  return { posts, send };
}

async function run(args: string[]) {
  const d = daemon();
  const out: string[] = [];
  const code = await perform(machineCall(['podman-host', ...args]), d.send, { out: (t) => out.push(t) });
  return { code, out: JSON.parse(out.join('')) as unknown, posts: d.posts };
}

describe('hopper machine podman-host (issue #2272)', () => {
  it('add with no --host-key reads the key to compare and adds nothing', async () => {
    const r = await run(['add', 'big-vm', 'sandbox@big-vm']);
    expect(r.posts).toEqual([{ path: '/ui/api/machines/host-key', body: { ssh: 'sandbox@big-vm' } }]);
    expect(r.out).toMatchObject({ added: false, fingerprint: 'SHA256:abc', hostKey: KEY });
    expect((r.out as { next: string }).next).toContain(`hopper machine podman-host add big-vm sandbox@big-vm --host-key '${KEY}'`);
  });

  it('add with --host-key posts the whole list with the new host, against the version read', async () => {
    const r = await run(['add', 'big-vm', 'sandbox@big-vm', '--host-key', KEY, '--cpus', '8', '--memory-mb', '16384', '--label', 'big']);
    expect(r.posts).toEqual([{ path: '/ui/api/podman-hosts', body: { version: 'v1', hosts: [HOST, { name: 'big-vm', ssh: 'sandbox@big-vm', hostKey: KEY, label: 'big', cpus: 8, memoryMb: 16384 }] } }]);
    expect(r.out).toHaveLength(2);
  });

  it('remove posts the list without the host', async () => {
    const r = await run(['remove', 'box-vm']);
    expect(r.posts).toEqual([{ path: '/ui/api/podman-hosts', body: { version: 'v1', hosts: [] } }]);
  });

  it('refuses a name taken, a name not there, and bad flags', async () => {
    await expect(run(['add', 'box-vm', 'sandbox@box-vm', '--host-key', KEY])).rejects.toThrow(OperatorRefusal);
    await expect(run(['remove', 'gone-vm'])).rejects.toThrow('no Podman host is named gone-vm');
    expect(() => machineCall(['podman-host', 'add', 'big-vm', 'sandbox@big-vm', '--port', '22'])).toThrow(OperatorRefusal);
    expect(() => machineCall(['podman-host', 'add', 'big-vm', 'sandbox@big-vm', '--cpus', 'many'])).toThrow(OperatorRefusal);
    expect(() => machineCall(['podman-host', 'add', 'big-vm'])).toThrow(OperatorRefusal);
  });
});
