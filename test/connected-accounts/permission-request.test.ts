// Issue #1378: the hopper cannot ask an owner for a permission itself. When the hopper's app asks for more than an
// installation granted, GitHub has asked that installation's owner to accept the new permissions. The **permission
// request** of an installation is that difference: what the app asks for, as `GET /apps/{slug}` answers it, that the
// installation does not grant yet.
import { describe, expect, it } from 'vitest';
import { permissionRequest } from '../../src/connected-accounts/identity.ts';

describe('an installation\'s permission request', () => {
  it('none when the installation grants every permission the app asks for, at its level or higher', () => {
    expect(permissionRequest({ issues: 'write', metadata: 'read' }, { issues: 'write', metadata: 'read' })).toEqual({});
    expect(permissionRequest({ checks: 'read' }, { checks: 'write' })).toEqual({});
  });

  it('a permission the installation lacks, or grants at a lower level, waits for its owner', () => {
    expect(permissionRequest({ checks: 'read', issues: 'write', actions: 'read' }, { checks: 'read', issues: 'read' }))
      .toEqual({ issues: 'write', actions: 'read' });
  });

  it('a permission the installation grants that the app no longer asks for is no request', () => {
    expect(permissionRequest({ issues: 'write' }, { issues: 'write', statuses: 'read' })).toEqual({});
  });
});
