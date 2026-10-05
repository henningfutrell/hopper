// The built-in instances are written as plugins.yaml once, into an empty store; an existing
// document is never replaced.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { builtinInstances, ensurePluginsDocument } from '../../src/plugins/builtin-instances.ts';
import { PLUGINS } from '../../src/plugins/plugins-file.ts';
import { useTempDocuments } from '../support/documents.ts';

const docs = useTempDocuments();
const logger = { info() {}, warn() {} };

describe('ensurePluginsDocument', () => {
  it('writes the built-in instances once into an empty store', () => {
    const documents = docs();
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, logger })).toEqual({ action: 'default' });
    const written = parse(documents.read(PLUGINS)!);
    expect(written).toMatchObject({ version: 1, ...JSON.parse(JSON.stringify(builtinInstances(1000))) });
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
  });

  it('a fresh install takes jobs through the gh CLI; the App source waits for an App of its own (#108)', () => {
    const { jobSources } = builtinInstances(1000);
    expect(jobSources).toEqual([
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
      { name: 'github-app', plugin: 'github-app' },
    ]);
  });

  it('keeps an existing document untouched', () => {
    const documents = docs();
    documents.set(PLUGINS, 'version: 1\nnotifiers: []\n');
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
    expect(documents.read(PLUGINS)).toBe('version: 1\nnotifiers: []\n');
  });

  it('a host that is not a machine (the container) lists no machine: an empty store gets `machines: []` (#141)', () => {
    expect(builtinInstances(1000, false).machines).toEqual([]);
    const documents = docs();
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, localMachine: false, logger })).toEqual({ action: 'default' });
    expect(parse(documents.read(PLUGINS)!).machines).toEqual([]);
  });

  it('a host that is not a machine removes the `local` instance an earlier boot wrote, and keeps every other machine (#141)', () => {
    const documents = docs();
    documents.set(PLUGINS, [
      'version: 1',
      '# the machines',
      'machines:',
      '  - { name: local, plugin: local, options: { lanes: 4 } }',
      '  - { name: box, plugin: docker, options: { docker: box } }',
      'notifiers: []',
      '',
    ].join('\n'));
    const lines: string[] = [];
    const r = ensurePluginsDocument({ documents, answerTimeoutMs: 1000, localMachine: false, logger: { info: (l) => lines.push(l), warn() {} } });
    expect(r).toEqual({ action: 'removed-local' });
    const doc = parse(documents.read(PLUGINS)!);
    expect(doc.machines).toEqual([{ name: 'box', plugin: 'docker', options: { docker: 'box' } }]);
    expect(doc.notifiers).toEqual([]);
    expect(documents.read(PLUGINS)).toContain('# the machines');
    expect(lines.join('\n')).toMatch(/removed the machine `local`/);
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, localMachine: false, logger })).toEqual({ action: 'kept' });
  });

  it('a machine keeps its `local` instance', () => {
    const documents = docs();
    const text = 'version: 1\nmachines:\n  - { name: local, plugin: local, options: { lanes: 2 } }\n';
    documents.set(PLUGINS, text);
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
    expect(documents.read(PLUGINS)).toBe(text);
  });
});
