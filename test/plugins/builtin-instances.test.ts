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

  it('keeps an existing document untouched', () => {
    const documents = docs();
    documents.set(PLUGINS, 'version: 1\nnotifiers: []\n');
    expect(ensurePluginsDocument({ documents, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
    expect(documents.read(PLUGINS)).toBe('version: 1\nnotifiers: []\n');
  });
});
