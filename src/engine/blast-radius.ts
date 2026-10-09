// Blast radius (issue #542, design.md "Blast radius and actor machines"): each machine discovered through its own
// connection — when it comes online in this run, every `everyMinutes`, and on demand —, the record kept in the user's
// settings with what changed since the one before; each machine rated from its record with the rules now, so a rule
// change applies at the next Decision; the gate the decider reads; a person letting a held job through.
// `machine.discovered` when a discovery changed something, `machine.radius_grew` when it raised the level,
// `machine.actor_mismatch` when an actor machine's rating is not what was declared; saving the settings is
// `blast_radius.settings_changed`. Both of the last two wake the engine, as does `job.gate_passed`.
import { AWS_ADMIN_ACTIONS, AWS_WRITE_ACTIONS, KUBE_CHECKS } from '../client/discover.ts';
import { changesOf, gateOf, higher, rate } from '../blast-radius/rate.ts';
import type { MachineShell } from '../domain/ports.ts';
import {
  BLAST_RADIUS_BOUNDS, DEFAULT_BLAST_RADIUS_SETTINGS, GATE_AT, heldAtGate, RADIUS_LEVELS, UNCONFIRMED_AS,
  type BlastRadiusInput, type BlastRadiusSettings, type BlastRadiusView, type DiscoveryRecord, type Job, type MachineRadiusView, type MachineSnapshot,
} from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** How often the engine looks for a machine whose discovery is due. */
export const DISCOVER_CHECK_MS = 60_000;

/** A settings change: any field, each replaced whole. `pass.minPriority: null` lets no job through by priority. */
export type BlastRadiusSettingsPatch = Partial<Omit<BlastRadiusSettings, 'pass'>> & {
  pass?: { labels?: string[]; repos?: string[]; minPriority?: number | null };
};

export interface BlastRadius {
  settings(): BlastRadiusSettings;
  /** What the decider reads now: the machines gated and what may pass. Kicks a discovery of a machine not yet discovered in this run. */
  input(machines: readonly MachineSnapshot[]): BlastRadiusInput;
  view(): Promise<BlastRadiusView>;
  /** Save a settings change (admin); throws EngineError `invalid`. */
  setSettings(patch: BlastRadiusSettingsPatch): Promise<BlastRadiusSettings>;
  /** Discover now: one machine, or every online one; resolves when done. Throws EngineError `not_found` for an unknown machine. */
  discoverNow(machineId?: string): Promise<BlastRadiusView>;
  /** Discover every online machine that is due. Never throws; one run at a time. */
  run(): Promise<void>;
  /** Let a job held at the gate through (a person): it may run on a gated machine. */
  letThrough(jobId: string): Job;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT = /^\d{12}$/;

function names(list: unknown, what: string, valid: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(list) || list.length > 64) throw new EngineError('invalid', `${what} must be a list of at most 64`);
  const out = list.map((x) => (typeof x === 'string' ? x.trim() : ''));
  const bad = out.find((x) => x.length === 0 || x.length > 200 || !valid(x));
  if (bad !== undefined) throw new EngineError('invalid', `${what}: ${bad === '' ? 'an empty entry' : `${bad} is not valid`}`);
  return [...new Set(out)];
}

function checked(patch: BlastRadiusSettingsPatch, was: BlastRadiusSettings, machineIds: ReadonlySet<string>): BlastRadiusSettings {
  const next: BlastRadiusSettings = {
    gateAt: patch.gateAt ?? was.gateAt,
    pass: { ...was.pass },
    rules: patch.rules ? { ...patch.rules } : was.rules,
    actors: patch.actors ?? was.actors,
    everyMinutes: patch.everyMinutes ?? was.everyMinutes,
  };
  if (patch.pass) {
    if (patch.pass.labels !== undefined) next.pass.labels = names(patch.pass.labels, 'pass.labels');
    if (patch.pass.repos !== undefined) next.pass.repos = names(patch.pass.repos, 'pass.repos', (r) => REPO.test(r));
    if (patch.pass.minPriority === null) delete next.pass.minPriority;
    else if (patch.pass.minPriority !== undefined) next.pass.minPriority = patch.pass.minPriority;
  }
  if (!(GATE_AT as readonly string[]).includes(next.gateAt)) throw new EngineError('invalid', `gateAt must be one of ${GATE_AT.join(', ')}`);
  const whole = (v: unknown, k: keyof typeof BLAST_RADIUS_BOUNDS, what: string): void => {
    const b = BLAST_RADIUS_BOUNDS[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) throw new EngineError('invalid', `${what} must be a whole number from ${b.min} to ${b.max}`);
  };
  whole(next.everyMinutes, 'everyMinutes', 'everyMinutes');
  if (next.pass.minPriority !== undefined) whole(next.pass.minPriority, 'minPriority', 'pass.minPriority');
  if (patch.rules) {
    next.rules = {
      prodPatterns: names(patch.rules.prodPatterns, 'rules.prodPatterns'),
      prodAccounts: names(patch.rules.prodAccounts, 'rules.prodAccounts', (a) => ACCOUNT.test(a)),
      unconfirmed: patch.rules.unconfirmed,
    };
    if (!(UNCONFIRMED_AS as readonly string[]).includes(next.rules.unconfirmed)) throw new EngineError('invalid', `rules.unconfirmed must be one of ${UNCONFIRMED_AS.join(', ')}`);
  }
  if (patch.actors) {
    const seen = new Set<string>();
    next.actors = patch.actors.map((a) => {
      if (!machineIds.has(a.machineId)) throw new EngineError('invalid', `no machine ${a.machineId}`);
      if (seen.has(a.machineId)) throw new EngineError('invalid', `machine ${a.machineId} is named twice`);
      seen.add(a.machineId);
      const purpose = typeof a.purpose === 'string' ? a.purpose.trim() : '';
      if (purpose.length === 0 || purpose.length > 200) throw new EngineError('invalid', 'an actor machine\'s purpose must be 1 to 200 characters');
      if (!(RADIUS_LEVELS as readonly string[]).includes(a.expected)) throw new EngineError('invalid', `expected must be one of ${RADIUS_LEVELS.join(', ')}`);
      return { machineId: a.machineId, purpose, expected: a.expected };
    });
  }
  return next;
}

export function createBlastRadius(c: EngineContext, log: (line: string) => void = (l) => console.warn(l)): BlastRadius {
  const { store } = c;
  /** Machines discovered (or tried) in this run, and when. */
  const last = new Map<string, number>();
  /** The records, read from the store once per machine. */
  const records = new Map<string, DiscoveryRecord | undefined>();
  let busy: Promise<void> | undefined;

  const settings = (): BlastRadiusSettings => store.settings.getBlastRadius() ?? DEFAULT_BLAST_RADIUS_SETTINGS;
  const recordOf = (id: string): DiscoveryRecord | undefined => {
    if (!records.has(id)) records.set(id, store.settings.getDiscovery(id));
    return records.get(id);
  };
  const levelOf = (id: string, s: BlastRadiusSettings) => {
    const facts = recordOf(id)?.facts;
    return facts ? rate(facts, s.rules) : undefined;
  };

  /** The machine as the first executor there that reaches it does; a container target has no shell. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    if (m.docker) return undefined;
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };

  async function discoverOne(m: MachineSnapshot, shell: MachineShell): Promise<void> {
    last.set(m.id, c.clock.now().getTime());
    const prev = recordOf(m.id);
    let facts;
    try {
      facts = await shell.discover();
    } catch (e) {
      if (c.stopping()) return;
      const error = (e as Error).message.slice(0, 500);
      const record: DiscoveryRecord = { ...(prev ?? { machineId: m.id }), machineId: m.id, at: nowIso(c), error };
      delete record.changes;
      records.set(m.id, record);
      store.tx(() => {
        store.settings.setDiscovery(record);
        if (prev?.error !== error) store.events.append({ type: 'machine.discovery_failed', machineId: m.id, data: { machineId: m.id, error } });
      });
      log(`hopper: could not discover ${m.id}: ${error}`);
      return;
    }
    if (c.stopping()) return;
    const s = settings();
    const level = rate(facts, s.rules).level;
    const changes = changesOf(prev?.facts, facts, prev?.level, level);
    const at = nowIso(c);
    const grew = prev?.level !== undefined && higher(level, prev.level) ? { from: prev.level, to: level, at }
      : prev?.grew && prev.level === level ? prev.grew : undefined;
    const actor = s.actors.find((a) => a.machineId === m.id);
    const mismatch = actor !== undefined && actor.expected !== level ? { expected: actor.expected, found: level } : undefined;
    const told = mismatch !== undefined && prev?.mismatch?.expected === mismatch.expected && prev.mismatch.found === mismatch.found;
    const record: DiscoveryRecord = { machineId: m.id, at, facts, changes, level, ...(grew ? { grew } : {}), ...(mismatch ? { mismatch } : {}) };
    records.set(m.id, record);
    store.tx(() => {
      store.settings.setDiscovery(record);
      if (changes.first || changes.added.length > 0 || changes.removed.length > 0 || changes.level) {
        store.events.append({ type: 'machine.discovered', machineId: m.id, data: { machineId: m.id, level, changes } });
      }
      if (record.grew && record.grew.at === at) store.events.append({ type: 'machine.radius_grew', machineId: m.id, data: { machineId: m.id, from: record.grew.from, to: level } });
      if (mismatch && !told) store.events.append({ type: 'machine.actor_mismatch', machineId: m.id, data: { machineId: m.id, ...mismatch } });
    });
  }

  async function discover(due: (m: MachineSnapshot) => boolean): Promise<void> {
    const machines = (await c.machines.list()).filter((m) => m.online && due(m));
    for (const m of machines) {
      if (c.stopping()) return;
      const shell = shellOf(m);
      if (!shell) {
        last.set(m.id, c.clock.now().getTime());
        continue;
      }
      await discoverOne(m, shell);
    }
  }

  /** One at a time: a call while one runs waits for it, then runs its own. */
  function serially(due: (m: MachineSnapshot) => boolean): Promise<void> {
    const run = (busy ?? Promise.resolve()).then(() => discover(due)).catch((e: unknown) => log(`hopper: discovery failed: ${(e as Error).message}`));
    busy = run;
    void run.finally(() => { if (busy === run) busy = undefined; });
    return run;
  }

  const isDue = (m: MachineSnapshot): boolean => {
    const at = last.get(m.id);
    return at === undefined || c.clock.now().getTime() - at >= settings().everyMinutes * 60_000;
  };

  async function view(): Promise<BlastRadiusView> {
    const s = settings();
    const machines: MachineRadiusView[] = (await c.machines.list()).map((m) => {
      const discovery = recordOf(m.id);
      const rating = levelOf(m.id, s);
      const actor = s.actors.find((a) => a.machineId === m.id);
      const gated = gateOf(m.id, rating?.level, s);
      return {
        machineId: m.id, label: m.label, online: m.online, discoverable: shellOf(m) !== undefined,
        ...(discovery ? { discovery } : {}), ...(rating ? { rating } : {}),
        ...(actor ? { actor: { ...actor, mismatch: rating !== undefined && rating.level !== actor.expected } } : {}),
        ...(gated ? { gated } : {}),
      };
    });
    return {
      settings: s, defaults: DEFAULT_BLAST_RADIUS_SETTINGS, machines,
      awsActions: { write: [...AWS_WRITE_ACTIONS], admin: [...AWS_ADMIN_ACTIONS] }, kubeChecks: [...KUBE_CHECKS],
    };
  }

  return {
    settings,
    input(machines) {
      const s = settings();
      // A machine online and not yet tried in this run: it attached, or the hopper started.
      if (!busy && machines.some((m) => m.online && !last.has(m.id) && !m.docker)) void serially((m) => !last.has(m.id));
      const gated = machines.flatMap((m) => {
        const reason = gateOf(m.id, levelOf(m.id, s)?.level, s);
        return reason ? [{ machineId: m.id, reason }] : [];
      });
      return { gated, pass: s.pass };
    },
    view,
    async setSettings(patch) {
      const machines = await c.machines.list();
      const was = settings();
      const next = checked(patch, was, new Set(machines.map((m) => m.id)));
      store.tx(() => {
        store.settings.setBlastRadius(next);
        if (JSON.stringify(was) !== JSON.stringify(next)) store.events.append({ type: 'blast_radius.settings_changed', data: { from: was, to: next } });
      });
      return next;
    },
    async discoverNow(machineId) {
      if (machineId !== undefined && !(await c.machines.list()).some((m) => m.id === machineId)) throw new EngineError('not_found', `no machine ${machineId}`);
      await serially((m) => machineId === undefined || m.id === machineId);
      return view();
    },
    run: () => serially(isDue),
    letThrough(jobId) {
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        if (!job) throw new EngineError('not_found', `job not found: ${jobId}`);
        if (!heldAtGate(job)) throw new EngineError('conflict', `job ${jobId} is not held at the blast-radius gate`);
        const next = store.jobs.update(jobId, { gatePass: { at: nowIso(c) } });
        store.events.append({ type: 'job.gate_passed', jobId, data: { reason: job.holdReason } });
        return next;
      });
    },
  };
}
