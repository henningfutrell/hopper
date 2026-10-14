// Issue #604: a box whose template is not there — a record from before removal was refused while boxes are attached —
// is an instance of nothing. Access writes no `instance_of` tuple for it, and the vault gives it nothing.
//
// Feature: a box of a template that is not there
//   Scenario: it is no box for Access, and its scope is empty
//     Given the vault holds the template kube and no template gone
//     And the box kbox of kube and the box gbox of gone are attached
//     Then the boxes Access writes are kbox only
//     And gbox may be given no secret
import { describe, expect, it } from 'vitest';
import type { Template } from '../../src/domain/vault.ts';
import { createVaultService } from '../../src/vault/service.ts';

const KUBE: Template = { name: 'kube', image: 'localhost/box:1', secrets: ['KUBE_TOKEN'], savedBy: 'Ada', savedAt: '2026-10-09T00:00:00Z' };

function vaultWith(templates: Template[]) {
  const store = {
    vault: {
      list: () => [], get: () => undefined, add: () => true, replace: () => true, sealed: () => undefined, remove: () => false,
      templates: () => templates, template: (name: string) => templates.find((t) => t.name === name),
    },
    events: { append: (e: unknown) => e },
    tx: <T>(fn: () => T): T => fn(),
    jobs: { get: () => undefined },
    settings: { getBlastRadius: () => undefined },
  };
  return createVaultService({
    store: store as never, keys: { problem: 'no key' }, clock: { now: () => new Date('2026-10-09T00:00:00Z') },
    idGen: () => 'id-1', logger: { warn: () => {} }, holds: () => true,
    targets: () => [{ name: 'kbox', key: 'k1', template: 'kube' }, { name: 'gbox', key: 'k2', template: 'gone' }, { name: 'laptop', key: 'k3' }],
  });
}

describe('a box of a template that is not there (issue #604)', () => {
  it('is no box for Access, and its scope is empty', () => {
    const vault = vaultWith([KUBE]);
    expect(vault.boxes()).toEqual([{ machine: 'kbox', template: 'kube' }]);
    expect(vault.scopeOf('gbox').secrets).toEqual([]);
  });
});
