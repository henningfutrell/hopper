// Issue #142: an executor is disabled in the UI by removing its instance, and executors follow
// plugins.yaml live — so a removal is refused while a job still needs that executor (waiting, running,
// or parked on a question), as a machine's is. The refusal names the jobs.
import { describe, expect, it } from 'vitest';
import type { ConfigDocuments } from '../../src/domain/ports.ts';
import type { ConfiguredInstance } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { applyEdit } from '../../src/plugins/edit.ts';

const FILE = 'version: 1\nexecutors:\n  - { name: test, plugin: test }\n  - { name: cursor, plugin: cursor-agent }\n';

function documents(text: string): ConfigDocuments & { text(): string } {
  let current = text;
  let v = 1;
  return {
    read: () => current,
    version: () => `v${v}`,
    write: (_n, next, version) => { if (version !== `v${v}`) return false; current = next; v += 1; return true; },
    text: () => current,
  };
}

const configured: ConfiguredInstance[] = [
  { role: 'executor', instance: { name: 'test', plugin: 'test', options: {} } },
  { role: 'executor', instance: { name: 'cursor', plugin: 'cursor-agent', options: {} } },
];
const find = (id: string) => {
  const definition = BUILTIN_PLUGINS.find((p) => p.id === id);
  return definition ? { definition, detection: { status: 'available' as const } } : undefined;
};

describe('removing an executor instance', () => {
  it('refused (409, naming the jobs) while a job needs it; nothing written', () => {
    const docs = documents(FILE);
    const r = applyEdit({ action: 'remove', role: 'executor', name: 'cursor', version: 'v1' }, {
      documents: docs, configured, find, inUse: (role, name) => (role === 'executor' && name === 'cursor' ? ['job-1', 'job-2'] : []),
    });
    expect(r).toEqual({ ok: false, code: 'conflict', error: 'cursor still has jobs (job-1, job-2): wait for them to end, or cancel them, then remove it' });
    expect(docs.text()).toBe(FILE);
  });

  it('removed when no job needs it', () => {
    const docs = documents(FILE);
    const r = applyEdit({ action: 'remove', role: 'executor', name: 'cursor', version: 'v1' }, { documents: docs, configured, find, inUse: () => [] });
    expect(r).toEqual({ ok: true, changed: true });
    expect(docs.text()).toBe('version: 1\nexecutors:\n  - { name: test, plugin: test }\n');
  });
});
