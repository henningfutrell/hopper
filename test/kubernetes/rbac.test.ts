// The hopper's role for job pods (issue #1283): it may manage pods in its own namespace and nothing else.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

const docs = parseAllDocuments(readFileSync(fileURLToPath(new URL('../../deploy/kubernetes/rbac.yaml', import.meta.url)), 'utf8'))
  .map((d) => d.toJS() as { kind: string; metadata: { name: string; namespace?: string }; rules?: { apiGroups: string[]; resources: string[]; verbs: string[] }[]; roleRef?: { kind: string }; subjects?: { kind: string; name: string }[] });

describe('the hopper\'s role for job pods', () => {
  it('is a namespaced Role on pods alone, bound to the hopper\'s service account: no cluster role, no Secrets, no other kind', () => {
    expect(docs.map((d) => d.kind)).toEqual(['ServiceAccount', 'Role', 'RoleBinding']);
    expect(docs.some((d) => d.kind.startsWith('Cluster'))).toBe(false);
    const role = docs.find((d) => d.kind === 'Role')!;
    expect(role.rules).toEqual([{ apiGroups: [''], resources: ['pods'], verbs: ['create', 'get', 'list', 'watch', 'delete'] }]);
    const binding = docs.find((d) => d.kind === 'RoleBinding')!;
    expect(binding.roleRef?.kind).toBe('Role');
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'hopper' }]);
  });
});
