// Issue #361: the Machines view's model of a machine's work tree: set in each machine's Edit form, and shown
// with the machine (the jobs directory when it names none).
import { describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { DETAILS, editBody, editDraft, editProblem, kindOf, localBody, workTreeText } from '../../ui/src/model/machines.ts';

const CONFIG: MachinesConfig = {
  version: 'v1',
  machines: [
    { name: 'local', connection: 'local', options: { lanes: 4 } },
    { name: 'desk', connection: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'] } },
    { name: 'box', connection: 'docker', options: { docker: 'box', lanes: 2 } },
    { name: 'odd', connection: 'custom-machines' },
  ],
  executors: ['herdr-claude', 'test'],
  defaults: { lanes: 1, executors: ['herdr-claude'] },
  ssh: { targets: ['laptop', 'desk'], notes: [], here: [] },
};

// Issue #361: each machine's work tree is set in the Machines view, and the view says when it cannot be made.
describe('a machine\'s work tree', () => {
  const desk = kindOf(CONFIG, 'desk');
  const box = kindOf(CONFIG, 'box');
  if (desk.kind !== 'attached' || box.kind !== 'attached') throw new Error('desk and box are attached');

  it('an attached machine\'s Edit form sets it, trimmed; emptied, the option goes (the jobs directory applies); a container target has none', () => {
    const d = editDraft(desk);
    expect(editBody(desk, { ...d, details: { ...d.details, workTree: ' ~/work ' } }, 'v1')?.options).toEqual({ ssh: 'desk', workTree: '~/work', lanes: 1, executors: ['test'] });
    const set = kindOf({ ...CONFIG, machines: [{ name: 'desk', connection: 'ssh', options: { ssh: 'desk', workTree: '/srv/w' } }] }, 'desk');
    if (set.kind !== 'attached') throw new Error('attached');
    expect(editDraft(set).details.workTree).toBe('/srv/w');
    expect(editBody(set, { ...editDraft(set), details: { ...editDraft(set).details, workTree: '' } }, 'v1')?.options).toEqual({ ssh: 'desk', lanes: 1, executors: ['herdr-claude'] });
    expect(DETAILS.docker!.map((f) => f.key)).not.toContain('workTree');
  });

  it('editProblem: a work tree that is neither absolute nor under ~', () => {
    const d = editDraft(desk);
    expect(editProblem(desk, { ...d, details: { ...d.details, workTree: 'work' } }, CONFIG)).toMatch(/work tree is an absolute path or starts with ~/);
    expect(editProblem(desk, { ...d, details: { ...d.details, workTree: '~/work' } }, CONFIG)).toBeNull();
  });

  it('this machine\'s Edit form sets it the same way', () => {
    const local = kindOf(CONFIG, 'local');
    if (local.kind !== 'local') throw new Error('local');
    expect(localBody(local, { name: 'local', lanes: '4', workTree: ' ~/w ' }, 'v1')?.options).toEqual({ workTree: '~/w', lanes: 4 });
    expect(localBody(local, { name: 'local', lanes: '4', workTree: 'w' }, 'v1')).toBeNull();
  });

  it('what the view shows: the work tree (the jobs directory when it names none), and what is wrong with it', () => {
    const base = { id: 'desk', label: 'desk', maxLanes: 1, online: true, executors: [] };
    expect(workTreeText({ ...base, ssh: 'desk' })).toBe('~/hopper-jobs (the jobs directory)');
    expect(workTreeText({ ...base, ssh: 'desk', workTree: '/srv/w' })).toBe('/srv/w');
    expect(workTreeText({ ...base, docker: 'c' })).toBeNull();
  });
});
