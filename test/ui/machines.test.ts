// The Machines view's model (issues #18, #74): which machine is a `local` instance and which an
// attached one (an instance of `ssh`, `docker` or `client`), what an Add form may send to
// POST /ui/api/machines and an Edit form to POST /ui/api/plugins, and why it may not yet.
import { describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { addBody, addProblem, authorizedKeysLine, hostKeyCheck, clientReleaseText, defaultsBody, DETAILS, editBody, editDraft, editProblem, hasThisMachine, isThisMachineTarget, kindOf, mayAddThisMachine, localBody, newDraft, newThisDraft, thisBody, thisProblem, type MachineDraft } from '../../ui/src/model/machines.ts';

const CONFIG: MachinesConfig = {
  version: 'v1',
  machines: [
    { name: 'local', connection: 'local', options: { lanes: 4 } },
    { name: 'desk', connection: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr' } },
    { name: 'box', connection: 'docker', options: { docker: 'box', lanes: 2 } },
    { name: 'odd', connection: 'custom-machines' },
  ],
  executors: ['herdr-claude', 'test'],
  defaults: { lanes: 1, executors: ['herdr-claude'] },
  ssh: { targets: ['laptop', 'desk'], notes: [], here: [] },
};

const draft = (over: Partial<MachineDraft> = {}): MachineDraft => ({ name: 'laptop', ssh: 'laptop', lanes: '2', executors: ['herdr-claude'], label: '', ...over });

describe('kindOf', () => {
  it('a local instance is local; an ssh, docker or client instance is attached, with its lanes, executors and label; anything else is unknown', () => {
    expect(kindOf(CONFIG, 'local')).toEqual({ kind: 'local', machine: CONFIG.machines[0], lanes: 4 });
    expect(kindOf(CONFIG, 'desk')).toEqual({ kind: 'attached', machine: CONFIG.machines[1], lanes: 1, executors: ['test'] });
    expect(kindOf(CONFIG, 'box')).toEqual({ kind: 'attached', machine: CONFIG.machines[2], lanes: 2, executors: ['command'] });
    expect(kindOf(CONFIG, 'odd')).toEqual({ kind: 'unknown' });
    expect(kindOf(CONFIG, 'other')).toEqual({ kind: 'unknown' });
    expect(kindOf(null, 'local')).toEqual({ kind: 'unknown' });
  });

  it('local lanes default to 4 when the instance sets none', () => {
    expect(kindOf({ ...CONFIG, machines: [{ name: 'local', connection: 'local' }] }, 'local')).toMatchObject({ kind: 'local', lanes: 4 });
  });
});

describe('addProblem', () => {
  it('none for a complete draft', () => {
    expect(addProblem(draft(), CONFIG)).toBeNull();
  });

  it('names what is missing or refused, as the daemon would', () => {
    expect(addProblem(draft({ name: ' ' }), CONFIG)).toMatch(/name/);
    expect(addProblem(draft({ name: 'local' }), CONFIG)).toMatch(/local/);
    expect(addProblem(draft({ name: 'desk' }), CONFIG)).toMatch(/desk/);
    expect(addProblem(draft({ name: 'odd' }), CONFIG)).toMatch(/odd/);
    expect(addProblem(draft({ ssh: '' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ ssh: '-oProxyCommand=x' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ ssh: 'two words' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ lanes: '0' }), CONFIG)).toMatch(/lanes/);
    expect(addProblem(draft({ lanes: '1.5' }), CONFIG)).toMatch(/lanes/);
  });
});

// Issue #293: in an ephemeral container there is no ~/.ssh/config to pick from, so a target is typed too.
describe('a typed ssh target', () => {
  it('a plain [user@]host may be sent, as a detected alias may', () => {
    expect(addProblem(draft({ ssh: 'user@host.containers.internal' }), CONFIG)).toBeNull();
    expect(addProblem(draft({ ssh: '192.0.2.20' }), { ...CONFIG, ssh: { ...CONFIG.ssh, targets: [] } })).toBeNull();
  });

  it('the host key the person confirmed goes with the body; none confirmed, none sent', () => {
    expect(addBody(draft({ ssh: 'user@box' }), 'v1', 'ssh-ed25519 AAAA')).toMatchObject({ ssh: 'user@box', hostKey: 'ssh-ed25519 AAAA' });
    expect(addBody(draft(), 'v1')).not.toHaveProperty('hostKey');
  });

  it('how to check a host key on the machine itself: the fingerprint of its own host key file', () => {
    expect(hostKeyCheck('ssh-ed25519 AAAA')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect(hostKeyCheck('ecdsa-sha2-nistp256 AAAA')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub');
    expect(hostKeyCheck('ssh-rsa AAAA')).toBe('ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub');
  });

  it('the line to add to the machine\'s authorized_keys: the hopper\'s key, restricted', () => {
    expect(authorizedKeysLine({ ...CONFIG, ssh: { ...CONFIG.ssh, publicKey: 'ssh-ed25519 AAAA hopper' } })).toBe('restrict ssh-ed25519 AAAA hopper');
    expect(authorizedKeysLine(CONFIG)).toBeNull();
  });
});

describe('the bodies sent', () => {
  it('add: trimmed name and label, lanes as a number; an empty label is left out; never herdrBin or session', () => {
    expect(addBody(draft({ name: ' laptop ', label: ' arch ' }), 'v1')).toEqual({
      name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], label: 'arch', version: 'v1',
    });
    expect(addBody(draft(), 'v1')).not.toHaveProperty('label');
  });

  it('edit: the instance\'s whole options with lanes, executors and label as typed, everything else kept; null when nothing changed', () => {
    const desk = kindOf({ ...CONFIG, machines: [{ ...CONFIG.machines[1]!, options: { ...CONFIG.machines[1]!.options, label: 'old' } }] }, 'desk');
    if (desk.kind !== 'attached') throw new Error('desk is attached');
    const d = editDraft(desk);
    expect(editBody(desk, { ...d, lanes: '3' }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'desk', version: 'v1',
      options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 3, executors: ['test'], label: 'old' },
    });
    expect(editBody(desk, { ...d, executors: ['herdr-claude', 'test'], label: '' }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'desk', version: 'v1',
      options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 1, executors: ['herdr-claude', 'test'] },
    });
    expect(editBody(desk, d, 'v1')).toBeNull();
  });
});

// Issue #205: a machine's name and every detail of how it is reached are editable.
describe('editing a machine\'s name and details', () => {
  const desk = kindOf(CONFIG, 'desk');
  const box = kindOf(CONFIG, 'box');
  if (desk.kind !== 'attached' || box.kind !== 'attached') throw new Error('desk and box are attached');

  it('the Edit form starts from the instance: its name, and the details of its connection as set (empty when unset)', () => {
    expect(editDraft(desk)).toEqual({
      name: 'desk', lanes: '1', executors: ['test'], label: '', herdr: true,
      details: { ssh: 'desk', session: '', herdrBin: '/usr/bin/herdr', hostKey: '' },
    });
    expect(editDraft(box)).toEqual({ name: 'box', lanes: '2', executors: ['command'], label: '', herdr: true, details: { docker: 'box' } });
    expect(DETAILS.ssh!.map((f) => f.key)).toEqual(['ssh', 'session', 'herdrBin', 'hostKey']);
    expect(DETAILS.docker!.map((f) => f.key)).toEqual(['docker']);
    expect(DETAILS.client!.map((f) => f.key)).toEqual(['tokenEnv']);
  });

  it('a new name is sent as rename, trimmed; the details as typed, trimmed; an emptied optional detail goes', () => {
    const d = editDraft(desk);
    expect(editBody(desk, { ...d, name: ' study ', details: { ssh: ' laptop ', session: 'work', herdrBin: '', hostKey: '' } }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'desk', rename: 'study', version: 'v1',
      options: { ssh: 'laptop', session: 'work', lanes: 1, executors: ['test'] },
    });
    expect(editBody(box, { ...editDraft(box), details: { docker: 'other-box' } }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'box', version: 'v1', options: { docker: 'other-box', lanes: 2, executors: ['command'] },
    });
  });

  it('herdr switched off is written as herdr: false; switched back on, the option goes', () => {
    const d = editDraft(desk);
    expect(editBody(desk, { ...d, herdr: false }, 'v1')?.options).toEqual({ ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 1, executors: ['test'], herdr: false });
    const off = kindOf({ ...CONFIG, machines: [{ name: 'desk', connection: 'ssh', options: { ssh: 'desk', herdr: false } }] }, 'desk');
    if (off.kind !== 'attached') throw new Error('attached');
    expect(editDraft(off).herdr).toBe(false);
    expect(editBody(off, { ...editDraft(off), herdr: true }, 'v1')?.options).toEqual({ ssh: 'desk', lanes: 1, executors: ['herdr-claude'] });
  });

  it('editProblem: an empty name, a name another machine has, lanes not a whole number ≥ 1, a required detail emptied', () => {
    const d = editDraft(desk);
    expect(editProblem(desk, d, CONFIG)).toBeNull();
    expect(editProblem(desk, { ...d, name: ' ' }, CONFIG)).toMatch(/name/);
    expect(editProblem(desk, { ...d, name: 'local' }, CONFIG)).toMatch(/local/);
    expect(editProblem(desk, { ...d, lanes: '0' }, CONFIG)).toMatch(/lanes/);
    expect(editProblem(desk, { ...d, details: { ...d.details, ssh: ' ' } }, CONFIG)).toMatch(/ssh target/);
    expect(editProblem(desk, { ...d, details: { ...d.details, session: '' } }, CONFIG)).toBeNull();
  });

  it('local: a new name and the lane count, its other options kept; null when nothing changed', () => {
    const local = kindOf(CONFIG, 'local');
    if (local.kind !== 'local') throw new Error('local');
    expect(localBody(local, { name: 'laptop', lanes: '2' }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'local', rename: 'laptop', version: 'v1', options: { lanes: 2 },
    });
    expect(localBody(local, { name: 'local', lanes: '0' }, 'v1')).toEqual({ action: 'options', role: 'machine-source', name: 'local', version: 'v1', options: { lanes: 0 } });
    expect(localBody(local, { name: 'local', lanes: '4' }, 'v1')).toBeNull();
    expect(localBody(local, { name: ' ', lanes: '4' }, 'v1')).toBeNull();
    expect(localBody(local, { name: 'local', lanes: 'x' }, 'v1')).toBeNull();
  });
});

// Issue #142: a new machine starts from the machine defaults, which the Machines view edits.
describe('machine defaults', () => {
  it('the Add form starts from them: their lanes, and their executors that are configured', () => {
    expect(newDraft(CONFIG)).toEqual({ name: '', ssh: '', lanes: '1', executors: ['herdr-claude'], label: '' });
    expect(newDraft({ ...CONFIG, defaults: { lanes: 3, executors: ['cursor', 'test'] } })).toEqual({ name: '', ssh: '', lanes: '3', executors: ['test'], label: '' });
  });

  it('the defaults form sends lanes as a number and the executors picked; null while lanes is not a whole number ≥ 1', () => {
    expect(defaultsBody({ lanes: '2', executors: ['test'] }, 'v1')).toEqual({ lanes: 2, executors: ['test'], version: 'v1' });
    expect(defaultsBody({ lanes: '0', executors: ['test'] }, 'v1')).toBeNull();
    expect(defaultsBody({ lanes: 'x', executors: [] }, 'v1')).toBeNull();
  });
});

describe('clientReleaseText (issue #70)', () => {
  it('a client target\'s release, and whether it is the hopper\'s; nothing for any other machine or before a probe', () => {
    expect(clientReleaseText({ tokenEnv: 'T', release: '0123456789abcdef', current: true })).toBe('0123456789abcdef (the hopper\'s)');
    expect(clientReleaseText({ tokenEnv: 'T', release: '0123456789abcdef', current: false })).toBe('0123456789abcdef (not the hopper\'s: loaded once no job runs there)');
    expect(clientReleaseText({ tokenEnv: 'T', current: false })).toBe('none: older than releases, install it again (scripts/attach-client.sh)');
    expect(clientReleaseText({ tokenEnv: 'T' })).toBeNull();
    expect(clientReleaseText(undefined)).toBeNull();
  });
});

// Issue #260: this machine is added with no ssh target — a name, its herdr session and lanes.
describe('adding this machine', () => {
  const NONE: MachinesConfig = { ...CONFIG, machines: CONFIG.machines.filter((m) => m.connection !== 'local') };

  it('offered only while no machine is this one', () => {
    expect(hasThisMachine(CONFIG)).toBe(true);
    expect(hasThisMachine(NONE)).toBe(false);
  });

  it('starts with the hopper session and four lanes', () => {
    expect(newThisDraft()).toEqual({ name: '', session: 'hopper', lanes: '4', label: '' });
  });

  it('refused as the daemon would: no name, a taken name, no session, the default session, a session that is not a plain name, lanes not ≥ 1', () => {
    const d = { name: 'workstation', session: 'jobs', lanes: '2', label: '' };
    expect(thisProblem(d, NONE)).toBeNull();
    expect(thisProblem({ ...d, name: ' ' }, NONE)).toMatch(/name/);
    expect(thisProblem({ ...d, name: 'desk' }, NONE)).toMatch(/desk/);
    expect(thisProblem({ ...d, session: '' }, NONE)).toMatch(/session/);
    expect(thisProblem({ ...d, session: 'default' }, NONE)).toMatch(/default/);
    expect(thisProblem({ ...d, session: 'a b' }, NONE)).toMatch(/session/);
    expect(thisProblem({ ...d, lanes: '0' }, NONE)).toMatch(/lanes/);
  });

  it('the body: name, session, lanes as a number, label when given; never an ssh target', () => {
    expect(thisBody({ name: ' workstation ', session: ' jobs ', lanes: '2', label: ' main ' }, 'v1')).toEqual({ name: 'workstation', session: 'jobs', lanes: 2, label: 'main', version: 'v1' });
    expect(thisBody({ name: 'workstation', session: 'jobs', lanes: '2', label: '' }, 'v1')).not.toHaveProperty('label');
  });

  it('its Edit form changes its herdr session too; an emptied session goes back to the default', () => {
    const local = kindOf({ ...CONFIG, machines: [{ name: 'local', connection: 'local', options: { lanes: 4, session: 'jobs' } }] }, 'local');
    if (local.kind !== 'local') throw new Error('local is local');
    expect(localBody(local, { name: 'local', lanes: '4', session: 'work' }, 'v1')).toEqual({ action: 'options', role: 'machine-source', name: 'local', version: 'v1', options: { lanes: 4, session: 'work' } });
    expect(localBody(local, { name: 'local', lanes: '4', session: '' }, 'v1')).toEqual({ action: 'options', role: 'machine-source', name: 'local', version: 'v1', options: { lanes: 4 } });
    expect(localBody(local, { name: 'local', lanes: '4', session: 'jobs' }, 'v1')).toBeNull();
  });
});

// Issue #275: an ssh target that is this machine is added as this machine, no ssh; in a container this machine cannot be added.
describe('an ssh target that is this machine', () => {
  const HERE: MachinesConfig = { ...CONFIG, machines: CONFIG.machines.filter((m) => m.connection !== 'local'), ssh: { targets: ['laptop', 'self'], notes: [], here: ['self'] } };

  it('is marked, and the Add form may send it while no machine is this one', () => {
    expect(isThisMachineTarget(HERE, 'self')).toBe(true);
    expect(isThisMachineTarget(HERE, 'laptop')).toBe(false);
    expect(addProblem(draft({ name: 'workstation', ssh: 'self' }), HERE)).toBeNull();
    expect(addBody(draft({ name: 'workstation', ssh: 'self' }), 'v1')).toMatchObject({ name: 'workstation', ssh: 'self' });
  });

  it('refused in the form once this machine is added, naming it', () => {
    const added: MachinesConfig = { ...HERE, machines: CONFIG.machines };
    expect(addProblem(draft({ name: 'workstation', ssh: 'self' }), added)).toMatch(/self is this machine, already added as local/);
  });

  it('this machine may be added unless it is one already or the hopper runs in a container', () => {
    expect(mayAddThisMachine(HERE)).toBe(true);
    expect(mayAddThisMachine(CONFIG)).toBe(false);
    expect(mayAddThisMachine({ ...HERE, thisMachineRefused: 'the hopper runs in a container' })).toBe(false);
  });
});
