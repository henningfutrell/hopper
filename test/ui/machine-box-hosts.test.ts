// Issue #708: Add machine → A sandbox box offers where the box starts: the computer the hopper runs on, or a client
// target online now, through its own Podman (the remote runtime). A sandbox box is no place for another box.
import { describe, expect, it } from 'vitest';
import { boxHosts } from '../../ui/src/model/machines.ts';

describe('where a sandbox box can start', () => {
  const m = (id: string, online: boolean, client: boolean) => ({ id, label: id, maxLanes: 1, online, executors: [], ...(client ? { client: {} } : {}) });

  it('client targets online now, never a box itself, nor a machine reached over ssh', () => {
    expect(boxHosts([m('studio', true, true), m('laptop', false, true), m('hopper-sandbox-kube', true, true), m('build', true, false)])).toEqual(['studio']);
  });
});
