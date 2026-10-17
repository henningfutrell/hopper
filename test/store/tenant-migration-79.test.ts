// Tenant migration 79 (issue #865 part C): a container target runs each command in a one-shot sandbox box, through the
// sandbox module, not in a container of its own over docker exec. Every `docker` machine instance becomes a `container`
// instance of the same name, its lanes, executors and other options kept, its `docker` option gone; no machine is
// dropped. The `dockerBin` option of every `command` executor and `claude-plan` usage source goes: no docker CLI is run.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at78(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 78);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 79: a container target through the sandbox module', () => {
  it('each docker machine becomes a container machine of the same name; no machine and no other option is lost', () => {
    const raw = at78({
      version: 1,
      executors: [{ name: 'command', plugin: 'command', options: { timeoutMs: 5000, dockerBin: '/usr/bin/docker', sshBin: 'ssh' } }, { name: 'test', plugin: 'test' }],
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 4 } },
        { name: 'box', plugin: 'docker', options: { docker: 'hopper-target', lanes: 2, executors: ['command'], label: 'The box' } },
        { name: 'bare', plugin: 'docker', options: { docker: 'bare' } },
        { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1 } },
      ],
      usageSources: [{ name: 'claude-plan', plugin: 'claude-plan', options: { dockerBin: 'docker', intervalSeconds: 600 } }],
      routing: [{ name: 'to the box', match: { label: 'on-box' }, set: { machine: 'box', executor: 'command' } }],
    });
    migrateTenant(raw, 79);
    expect(plugins(raw)).toEqual({
      version: 1,
      executors: [{ name: 'command', plugin: 'command', options: { timeoutMs: 5000, sshBin: 'ssh' } }, { name: 'test', plugin: 'test' }],
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 4 } },
        { name: 'box', plugin: 'container', options: { lanes: 2, executors: ['command'], label: 'The box' } },
        { name: 'bare', plugin: 'container', options: {} },
        { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1 } },
      ],
      usageSources: [{ name: 'claude-plan', plugin: 'claude-plan', options: { intervalSeconds: 600 } }],
      routing: [{ name: 'to the box', match: { label: 'on-box' }, set: { machine: 'box', executor: 'command' } }],
    });
    raw.close();
  });

  it('a user with no plugins config, or none naming a container target: nothing changes', () => {
    const none = at78();
    migrateTenant(none, 79);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const config = { version: 1, machines: [{ name: 'local', plugin: 'local' }], executors: [{ name: 'command', plugin: 'command' }] };
    const raw = at78(config);
    migrateTenant(raw, 79);
    expect(plugins(raw)).toEqual(config);
    raw.close();
  });
});
