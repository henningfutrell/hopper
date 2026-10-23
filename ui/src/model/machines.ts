// The Machines view's model (design.md "Machines from the UI", issues #18, #74): which machine is
// this one (connection `local`) and which an attached one (connection `ssh`, `container` or `client`), why an Add
// form may not be sent yet, the body POST /ui/api/machines takes, and the options edit an Edit form
// sends to POST /ui/api/plugins — its name and every detail of how it is reached too (issue #205). An
// Add body over ssh never carries session; its ssh target is a detected one or a typed plain
// [user@]host, and its hostKey only the one the person confirmed (issue #293: an ephemeral container has
// no durable ~/.ssh); this machine is added with no ssh target,
// its name and its herdr session (issue #260), and so is an ssh target the daemon found is this machine
// (issue #275); in a container this machine cannot be added. A new machine starts from the machine
// defaults (issue #142), edited through POST /ui/api/machines/defaults.
import type { ConfiguredMachine, MachineDefaultsEdit, MachineEdit, MachineSnapshot, MachinesConfig, PluginsEdit } from '../../../src/domain/types.ts';

/** This machine's default lane count. */
const DEFAULT_LANES = 4;

/** The connections of an attached machine, and the executors each runs when the machine names none. */
const ATTACHED: Record<string, string[]> = { ssh: ['herdr-claude'], container: ['command'], client: ['herdr-claude'] };

export type MachineKind =
  | { kind: 'local'; machine: ConfiguredMachine; lanes: number }
  | { kind: 'attached'; machine: ConfiguredMachine; lanes: number; executors: string[]; label?: string }
  | { kind: 'unknown' };

export function kindOf(config: MachinesConfig | null, id: string): MachineKind {
  const machine = config?.machines.find((m) => m.name === id);
  if (!machine) return { kind: 'unknown' };
  const o = machine.options ?? {};
  if (machine.connection === 'local') return { kind: 'local', machine, lanes: typeof o.lanes === 'number' ? o.lanes : DEFAULT_LANES };
  const executors = ATTACHED[machine.connection];
  if (!executors) return { kind: 'unknown' };
  return {
    kind: 'attached', machine, lanes: typeof o.lanes === 'number' ? o.lanes : 1,
    executors: Array.isArray(o.executors) ? (o.executors as string[]) : executors,
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
  };
}

/** An Add form as typed. */
export interface MachineDraft { name: string; ssh: string; lanes: string; executors: string[]; label: string }
/** One detail of how an attached machine is reached: an option of its connection's plugin, edited as text. */
export interface DetailField { key: string; label: string; hint: string; required: boolean }

/** The details each connection's Edit form shows, in order (issue #205); `herdr` is a switch beside them. */
/** The jobs directory: a machine's work tree when it names none (mirrors `JOBS_DIR`). */
const JOBS_DIR = '~/hopper-jobs';

/** A machine's work tree (issue #361): where its jobs run, made there by the hopper. */
const WORK_TREE: DetailField = { key: 'workTree', label: 'work tree', hint: `where its jobs run; the hopper makes it, and in a folder that is no git repository fetches or clones each job's repository. ~ is its home. Empty: ${JOBS_DIR}`, required: false };

export const DETAILS: Record<string, DetailField[]> = {
  ssh: [
    { key: 'ssh', label: 'ssh target', hint: 'user@host, or a Host alias', required: true },
    { key: 'session', label: 'herdr session', hint: 'empty: hopper', required: false },
    { key: 'hostKey', label: 'host key', hint: '<type> <base64>, the only key accepted from it; empty: not connected. Another ssh target has its own', required: false },
    WORK_TREE,
  ],
  container: [{ key: 'image', label: 'image', hint: 'each command runs in a new sandbox box of this image, with no network; empty: the hopper\'s box image', required: false }],
  // A client target dials in with its machine key (issue #308): nothing of how it is reached to type.
  client: [WORK_TREE],
};

/** An absolute path, or one under `~` (the machine's home), as the daemon takes a work tree. */
const pathLike = (s: string): boolean => s.startsWith('/') || s === '~' || s.startsWith('~/');

/** The work tree the Machines view shows (issue #361): the machine's, else the jobs directory; null for a container target, which has none. */
export function workTreeText(m: MachineSnapshot): string | null {
  if (m.containerImage) return null;
  return m.workTree ?? `${JOBS_DIR} (the jobs directory)`;
}

/** The work trees a machine keeps per repository (issue #691), `owner/name → path`, sorted; null when it maps none. */
export function workTreesText(m: MachineSnapshot): string | null {
  const trees = Object.entries(m.workTrees ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return trees.length ? trees.map(([repo, path]) => `${repo} → ${path}`).join('; ') : null;
}

/** A sandbox box's template the Machines view shows (issue #602): its name, and whether it takes jobs; null for a machine of no template. */
export function templateText(m: MachineSnapshot): string | null {
  if (!m.template) return null;
  return m.template.waiting ? `${m.template.name}: takes no job, ${m.template.waiting}` : `${m.template.name}, approved: takes jobs`;
}

/**
 * A machine off the hopper's network on Machines (issue #711): why its jobs cannot reach the hopper, and the command that
 * joins it to the hopper's network when one fits; null for a machine whose jobs reach it.
 */
export function offNetwork(m: MachineSnapshot): { problem: string; fix?: string } | null {
  if (m.addressProblem === undefined) return null;
  return { problem: m.addressProblem, ...(m.addressFix ? { fix: m.addressFix } : {}) };
}

/** One side of a machine's herdr as Machines shows it (issue #741): its version, then its protocol and binary when read. */
function herdrSide(what: string, side: { version?: string; protocol?: number; binary?: string } | undefined): string | null {
  if (!side) return null;
  const said = [side.protocol !== undefined ? `protocol ${side.protocol}` : null, side.binary ?? null].filter((x) => x !== null).join(', ');
  return `${what}${side.version ? ` ${side.version}` : ''}${said ? ` (${said})` : ''}`;
}

/** What its job user holds (issues #1128 part 7, #1248, #1467): a warning, and a hold only when `credentialHeld`. None, or not read: null. */
export function infraCredentialsText(m: MachineSnapshot): string | null {
  if (!m.infraCredentials?.length) return null;
  return `Its job user holds credentials a job could use: ${m.infraCredentials.join(', ')}.`;
}

/** A machine as the credential check reads it (issue #1467): what the daemon says of it, from the decider's own rule. */
export type CredentialChecked = MachineSnapshot & { credentialHeld?: boolean; credentialAcceptance?: { credentials: readonly string[]; acceptedAt: string; revokedAt?: string } };

/**
 * The credential part of a Machines card (issue #1467): one state, the one the decider acts on. `held`: it takes no new job,
 * the reason and the guided fix shown first, and Use anyway. `warning`: it takes jobs, the warning shown, the guided fix
 * folded, and Acknowledge or Stop taking jobs. `acknowledged`: it takes jobs, an admin acknowledged every credential it
 * holds, the warning folded. A credential the acknowledgement did not name makes it `warning` again. Null: it holds none.
 */
export interface CredentialCard {
  state: 'held' | 'warning' | 'acknowledged';
  /** The card's badge. */
  badge: string;
  headline: string;
  /** What its job user holds, and for a hold why it is held. */
  detail: string;
  /** Credentials found since the acknowledgement. */
  added: string[];
  /** Whether the guided fix shows open. */
  fixOpen: boolean;
}

export const HELD_HEADLINE = 'Not taking jobs';
export const TAKING_HEADLINE = 'Taking jobs';

export function credentialCard(m: CredentialChecked): CredentialCard | null {
  const text = infraCredentialsText(m);
  if (!text) return null;
  const a = m.credentialAcceptance;
  if (m.credentialHeld) {
    const why = a?.revokedAt !== undefined ? 'An admin stopped it from taking jobs.' : 'Strict mode is on, and no admin chose to use it anyway.';
    return { state: 'held', badge: 'not taking jobs', headline: HELD_HEADLINE, detail: `${why} ${text} Its jobs wait for another machine. Run its jobs as a dedicated user that holds none; a job that needs a credential gets it from the vault, through a grant.`, added: [], fixOpen: true };
  }
  const named = a && a.revokedAt === undefined ? a.credentials : null;
  const added = named ? (m.infraCredentials ?? []).filter((c) => !named.includes(c)) : [];
  if (named && added.length === 0) return { state: 'acknowledged', badge: 'credentials acknowledged', headline: TAKING_HEADLINE, detail: text, added, fixOpen: false };
  return { state: 'warning', badge: 'credentials', headline: TAKING_HEADLINE, detail: text, added, fixOpen: false };
}

/** The dedicated job user the guided fix makes (issue #1248). */
export const JOB_USER = 'hopper-job';

/**
 * The guided fix for a machine not ready for its credentials (issue #1248): the commands an admin runs there to make a
 * dedicated job user with no credentials and no password, then how the machine moves to it. Its work tree is made under
 * that user's home by the next probe. Null: it holds none.
 */
export function jobUserFix(m: MachineSnapshot): { commands: string[]; then: string } | null {
  if (!m.infraCredentials?.length) return null;
  const make = [`sudo useradd --create-home --shell /bin/bash ${JOB_USER}`, `sudo passwd --lock ${JOB_USER}`];
  if (m.ssh) {
    const host = m.ssh.slice(m.ssh.indexOf('@') + 1);
    return { commands: make, then: `Then put the hopper's ssh public key in /home/${JOB_USER}/.ssh/authorized_keys there, and Edit this machine: set its ssh target to ${JOB_USER}@${host}. It takes jobs at its next probe.` };
  }
  const client = `Then Machines → Add machine → A computer, open a shell as that user with sudo -iu ${JOB_USER}, and run the line there. Remove this machine once the new one is online.`;
  if (m.client) return { commands: [...make, `sudo loginctl enable-linger ${JOB_USER}`], then: client };
  return { commands: [...make, `sudo loginctl enable-linger ${JOB_USER}`], then: `This is the hopper's own machine: remove the credentials from the hopper's user, or set its lanes to 0 and add this computer as a client target as that user. ${client}` };
}

/**
 * Needs you's lines (issues #1248, #1467): each online machine not taking jobs, and why; and each one that takes jobs with a
 * credential warning no admin acknowledged.
 */
export function notReadyLines(machines: readonly CredentialChecked[]): string[] {
  return machines.filter((m) => m.online).flatMap((m) => {
    const name = m.label || m.id;
    const card = credentialCard(m);
    const holds = m.infraCredentials?.join(', ');
    if (card?.state === 'held') return [`${name}: not taking jobs — its job user holds ${holds}`];
    if (m.addressProblem) return [`${name}: not ready — ${m.addressProblem}`];
    return card?.state === 'warning' ? [`${name}: takes jobs, but its job user holds ${holds}`] : [];
  });
}

/** An ssh target's herdr client and server versions on Machines (issue #741); null when its probe read none. */
export function herdrText(m: MachineSnapshot): string | null {
  const sides = [herdrSide('client', m.herdr?.client), herdrSide('server', m.herdr?.server)].filter((x) => x !== null);
  return sides.length ? sides.join(', ') : null;
}

/** The herdr the hopper owns on an ssh target (issue #741): its version, and whether every herdr call there runs it, or why not; null when not read. */
export function ownedHerdrText(m: MachineSnapshot): string | null {
  const o = m.herdr?.owned;
  if (!o) return null;
  const use = o.inUse ? 'in use' : `not in use${o.note ? `: ${o.note}` : ''}`;
  return o.version ? `${o.version}, ${use}` : use;
}

/** An Edit form as typed: its name, lanes, executors, label, the details of its connection, and (ssh) whether it runs herdr. */
export type MachineEditDraft = Pick<MachineDraft, 'name' | 'lanes' | 'executors' | 'label'> & { details: Record<string, string>; herdr: boolean };

/** A fresh Edit form: the machine as configured, a detail it does not set empty. */
export function editDraft(m: Extract<MachineKind, { kind: 'attached' }>): MachineEditDraft {
  const o = m.machine.options ?? {};
  const details = Object.fromEntries((DETAILS[m.machine.connection] ?? []).map((f) => [f.key, typeof o[f.key] === 'string' ? o[f.key] as string : '']));
  return { name: m.machine.name, lanes: String(m.lanes), executors: [...m.executors], label: m.label ?? '', details, herdr: o.herdr !== false };
}

/** Why the Edit form cannot be sent yet, or null. The daemon checks again. */
export function editProblem(m: Extract<MachineKind, { kind: 'attached' }>, d: MachineEditDraft, config: MachinesConfig): string | null {
  const name = d.name.trim();
  if (!name) return 'give the machine a name';
  if (name !== m.machine.name && config.machines.some((x) => x.name === name)) return `a machine is already named ${name}; pick another name`;
  if (lanesOf(d.lanes, 0) === undefined) return 'lanes must be a whole number; 0 rests it';
  const missing = (DETAILS[m.machine.connection] ?? []).find((f) => f.required && !(d.details[f.key] ?? '').trim());
  if (missing) return `give the ${missing.label}`;
  const tree = (d.details.workTree ?? '').trim();
  return tree && !pathLike(tree) ? 'the work tree is an absolute path or starts with ~' : null;
}

/** Lanes as typed, a whole number at least `min`: an attached machine being edited may rest at 0 (issue #365). */
const lanesOf = (s: string, min = 1): number | undefined => (/^\d+$/.test(s.trim()) && Number(s) >= min ? Number(s) : undefined);

/** A fresh Add form: the machine defaults' lanes, and those of their executors that are configured. */
export function newDraft(config: MachinesConfig): MachineDraft {
  return { name: '', ssh: '', lanes: String(config.defaults.lanes), executors: config.defaults.executors.filter((x) => config.executors.includes(x)), label: '' };
}

/** The machine defaults form as typed. */
export type MachineDefaultsDraft = Pick<MachineDraft, 'lanes' | 'executors'>;

/** POST /ui/api/machines/defaults, or null while lanes is not a whole number ≥ 1. */
export function defaultsBody(d: MachineDefaultsDraft, version: string): MachineDefaultsEdit | null {
  const lanes = lanesOf(d.lanes);
  return lanes === undefined ? null : { lanes, executors: [...d.executors], version };
}

/** Why the Add form cannot be sent yet, or null. The daemon checks again. */
export function addProblem(d: MachineDraft, config: MachinesConfig): string | null {
  const name = d.name.trim();
  if (!name) return 'give the machine a name';
  if (config.machines.some((m) => m.name === name)) return `a machine is already named ${name}; pick another name`;
  const alias = config.ssh.targets.length ? ', or a Host alias from ~/.ssh/config' : '';
  if (!d.ssh) return `give its ssh target: you@host${alias}`;
  if (!config.ssh.targets.includes(d.ssh) && !PLAIN_TARGET.test(d.ssh)) return `an ssh target is a plain you@host (letters, digits, dot, dash, underscore)${alias}`;
  const here = isThisMachineTarget(config, d.ssh) && config.machines.find((m) => m.connection === 'local');
  if (here) return `${d.ssh} is this machine, already added as ${here.name}; edit that one`;
  if (lanesOf(d.lanes) === undefined) return 'lanes must be a whole number, at least 1';
  return null;
}

/** A typed ssh target, as the daemon takes it: a plain `[user@]host`, which can carry no ssh option. */
const PLAIN_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;

/** POST /ui/api/machines over ssh; `hostKey` the one the person confirmed (issue #293), else none. */
export function addBody(d: MachineDraft, version: string, hostKey?: string): MachineEdit {
  const label = d.label.trim();
  return { name: d.name.trim(), ssh: d.ssh, lanes: lanesOf(d.lanes) ?? 0, executors: [...d.executors], ...(label ? { label } : {}), ...(hostKey ? { hostKey } : {}), version };
}

/** The command that prints, on the machine itself, the fingerprint of the host key it presents: `ssh-rsa` → rsa, `ecdsa-sha2-nistp256` → ecdsa. */
export function hostKeyCheck(hostKey: string): string {
  const type = (hostKey.split(' ')[0] ?? '').replace(/^ssh-/, '').replace(/-sha2-nistp\d+$/, '');
  return `ssh-keygen -lf /etc/ssh/ssh_host_${type}_key.pub`;
}

/** The line to add to a machine's ~/.ssh/authorized_keys so the hopper may reach it (issue #293): its own key, restricted; null when none is shown. */
export const authorizedKeysLine = (config: MachinesConfig): string | null => (config.ssh.publicKey ? `restrict ${config.ssh.publicKey}` : null);

/** The same options, whatever their key order and the order of executors. */
function sameOptions(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const norm = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, Array.isArray(o[k]) ? [...o[k] as unknown[]].sort() : o[k]]));
  return norm(a) === norm(b);
}

/** An options edit, with `rename` when the name typed differs; null when neither changed. */
function optionsEdit(m: MachineKind & { machine: ConfiguredMachine }, name: string, options: Record<string, unknown>, version: string): Extract<PluginsEdit, { action: 'options' }> | null {
  const rename = name !== m.machine.name ? name : undefined;
  if (!rename && sameOptions(options, m.machine.options ?? {})) return null;
  return { action: 'options', role: 'machine-source', name: m.machine.name, ...(rename ? { rename } : {}), version, options };
}

/**
 * The machine's whole options with lanes, executors, label and the details as typed — a cleared label
 * or optional detail goes; herdr switched off is `herdr: false` — and its new name; null when nothing changed.
 */
export function editBody(m: Extract<MachineKind, { kind: 'attached' }>, d: MachineEditDraft, version: string): Extract<PluginsEdit, { action: 'options' }> | null {
  const fields = DETAILS[m.machine.connection] ?? [];
  const drop = new Set(['label', 'herdr', ...fields.map((f) => f.key)]);
  const rest = Object.fromEntries(Object.entries(m.machine.options ?? {}).filter(([k]) => !drop.has(k)));
  const details = Object.fromEntries(fields.flatMap((f) => { const v = (d.details[f.key] ?? '').trim(); return v ? [[f.key, v]] : []; }));
  const label = d.label.trim();
  return optionsEdit(m, d.name.trim(), {
    ...details, ...rest, lanes: lanesOf(d.lanes, 0) ?? 0, executors: [...d.executors], ...(label ? { label } : {}),
    ...(m.machine.connection === 'ssh' && !d.herdr ? { herdr: false } : {}),
  }, version);
}

/** A local machine's Edit form as typed: its name, lane count, (issue #260) its herdr session — empty: the herdr-claude instance's own — and (issue #361) its work tree — empty: the jobs directory. */
export interface LocalDraft { name: string; lanes: string; session?: string; workTree?: string }

/** Its whole options with the lane count and session as typed (0 lanes runs none here), and its new name; null when nothing changed or while any is invalid. */
export function localBody(m: Extract<MachineKind, { kind: 'local' }>, d: LocalDraft, version: string): Extract<PluginsEdit, { action: 'options' }> | null {
  const name = d.name.trim();
  if (!name || !/^\d+$/.test(d.lanes.trim())) return null;
  const options: Record<string, unknown> = { ...m.machine.options, lanes: Number(d.lanes) };
  if (d.session !== undefined) {
    const session = d.session.trim();
    if (session && sessionProblem(session)) return null;
    if (session) options.session = session;
    else delete options.session;
  }
  if (d.workTree !== undefined) {
    const tree = d.workTree.trim();
    if (tree && !pathLike(tree)) return null;
    if (tree) options.workTree = tree;
    else delete options.workTree;
  }
  return optionsEdit(m, name, options, version);
}

/** A herdr session name, as the daemon takes it: plain, never `default`. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function sessionProblem(session: string): string | null {
  if (!session) return 'give the herdr session its jobs run in';
  if (session === 'default') return 'not the default herdr session: pick another name';
  if (!SESSION.test(session)) return 'a herdr session is a plain name: letters, digits, dot, dash, underscore';
  return null;
}

/** Whether a machine is this one already: then there is no adding it (issue #260). */
export const hasThisMachine = (config: MachinesConfig): boolean => config.machines.some((m) => m.connection === 'local');

/** Whether this machine may be added now: none is it yet, and the hopper does not run in a container (issue #275). */
export const mayAddThisMachine = (config: MachinesConfig): boolean => !hasThisMachine(config) && !config.thisMachineRefused;

/** Whether the daemon found an ssh target is this machine (issue #275): it is added as this machine, with no ssh. */
export const isThisMachineTarget = (config: MachinesConfig, target: string): boolean => config.ssh.here.includes(target);

/** The Add form for this machine as typed (issue #260): no ssh target — a name, its herdr session, lanes, a label. */
export interface ThisDraft { name: string; session: string; lanes: string; label: string }

export const newThisDraft = (): ThisDraft => ({ name: '', session: 'hopper', lanes: String(DEFAULT_LANES), label: '' });

/** Why this machine cannot be added as typed yet, or null. The daemon checks again. */
export function thisProblem(d: ThisDraft, config: MachinesConfig): string | null {
  const name = d.name.trim();
  if (!name) return 'give this machine a name';
  if (config.machines.some((m) => m.name === name)) return `a machine is already named ${name}; pick another name`;
  const session = sessionProblem(d.session.trim());
  if (session) return session;
  if (lanesOf(d.lanes) === undefined) return 'lanes must be a whole number, at least 1';
  return null;
}

/** POST /ui/api/machines without an ssh target: this machine. */
export function thisBody(d: ThisDraft, version: string): MachineEdit {
  const label = d.label.trim();
  return { name: d.name.trim(), session: d.session.trim(), lanes: lanesOf(d.lanes) ?? 0, ...(label ? { label } : {}), version };
}

/** A client target's client release, as the Machines view says it (issue #70); null before a probe found it online, or for any other machine. */
export function clientReleaseText(client: MachineSnapshot['client']): string | null {
  if (client?.current === undefined) return null;
  if (!client.release) return 'none: older than releases, add it again: Add machine';
  if (client.current) return `${client.release} (the hopper's)`;
  return client.update ? `${client.release} (not the hopper's, and it cannot be updated from here)` : `${client.release} (not the hopper's: loaded once no job runs there)`;
}

/**
 * The line that reinstalls the client of a client target the hopper could not update (issue #545): the
 * install the hopper serves, with no join code, run on that computer. Null while the hopper can still update it.
 */
export function clientUpdateLine(client: MachineSnapshot['client'], origin: string): string | null {
  return client?.update ? `curl -fsSL '${origin}/client/install' | sh -s -- '${origin}'` : null;
}

export const gb = (bytes: number): string => {
  const n = bytes / 1e9;
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)} GB`;
};

/** A machine's disk (issue #401) as its card says it, with the warning when it runs low or critical (issue #2494); null when it was not read. */
export function diskText(disk: MachineSnapshot['disk']): string | null {
  if (!disk) return null;
  const text = `${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)} (${Math.round((disk.freeBytes / disk.totalBytes) * 100)}%)`;
  if (disk.critical) return `${text}: critical, no job runs here until it frees`;
  return disk.low ? `${text}: low, jobs may fail as it fills` : text;
}

/** A machine's reserved lanes (issue #372) as its card says them; null when it keeps none. */
export function reservedText(m: Pick<MachineSnapshot, 'maxLanes' | 'reservedLanes'>): string | null {
  const n = m.reservedLanes ?? 0;
  if (n <= 0) return null;
  if (n >= m.maxLanes) return `all ${m.maxLanes}: only jobs pinned here run here`;
  return `${n} of ${m.maxLanes}, for jobs pinned here; jobs that could run anywhere use the other ${m.maxLanes - n}`;
}

/**
 * The one line Add machine shows (design.md "Joining a machine"): the computer runs the install the hopper serves, from
 * the URL this page is open at. A sandbox never joins as a machine (issue #1349).
 */
export function joinLine(o: { origin: string; code: string }): string {
  return `curl -fsSL '${o.origin}/client/install' | sh -s -- '${o.origin}#${o.code}'`;
}

/**
 * The commands Add machine's Pod / Kubernetes shows (issue #1454, design.md "Lane pods of another release"): a Secret with
 * the lane pool key the hopper issued, then a runner-only release of the chart (from a checkout of the hopper's repository)
 * whose lane pods join the hopper at `hopperUrl`. Nothing on the hopper restarts.
 */
export function podRunnerCommands(o: { hopperUrl: string; key: string; namespace?: string; release?: string }): { secret: string; helm: string } {
  const ns = o.namespace ?? 'hopper-runner';
  const release = o.release ?? 'runner';
  const secretName = `${release}-pool-key`;
  return {
    secret: `kubectl create namespace ${ns} && kubectl -n ${ns} create secret generic ${secretName} --from-literal=key='${o.key}'`,
    helm: `helm install ${release} deploy/helm/hopper -n ${ns} --set hopper.enabled=false --set lanes.replicas=1 --set lanes.hopperUrl='${o.hopperUrl.replace(/\/+$/, '')}' --set lanes.existingSecret=${secretName}`,
  };
}

/** Whether pods in a cluster cannot reach a hopper at this URL: it names this computer's loopback only. */
export const loopbackOnly = (url: string): boolean => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
};
