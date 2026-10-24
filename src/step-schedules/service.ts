// One user's step schedules (issue #2716, design.md "Step schedules"): a person saves a schedule — a template, a folder and
// a script of a repository, a daily time in UTC and a timeout —, and the hopper runs that script as a box step at each due
// time, with no job and no agent: in a new need box of the template (the sandbox module's `needStep`, which writes the
// sandbox runs ledger), the folder read at the repository's default branch with the user's own GitHub connection and put
// in the box's work directory at its path, the template's vault secrets copied in once a person granted the schedule the
// vault. A template whose profiles the vault mints takes no schedule: no credential is minted for one (not built).
//
// Each run is claimed in the database first (one per schedule and due time, and none while one has not ended), then run
// by its `scheduled-run` saga (saga.ts) on whichever host holds it. A run whose need box started on a hopper that stopped
// is never run again: it ends `interrupted`, as a need step does. A due time a stopped hopper missed is run once when it
// starts; older ones are not. A run that fails, or that the hopper could not start, is `step_schedule.run_failed`, which
// the notifiers send, and Needs you lists its schedule until a run of it succeeds.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { templateWait } from '../domain/sandboxes-before-start.ts';
import {
  changesWhatRuns, dueNow, failedSchedules, nextDue, SCHEDULED_RUNS_KEPT, stepScheduleProblem,
  type ScheduledRun, type ScheduledRunTrigger, type StepSchedule, type StepScheduleFields, type StepScheduleRepository, type StepScheduleRunsView, type StepSchedulesView, type StepScheduleView,
} from '../domain/step-schedules.ts';
import type { NewEvent } from '../domain/types.ts';
import { isSharedSecret, type TemplateView } from '../domain/vault.ts';
import { filesTar } from '../sandbox/socket-http.ts';
import { needEnv, type NeedBox, type NeedBoxResult } from '../sandbox/need-box.ts';
import { boxNeeds, STEP_INTERRUPTED } from '../sandbox/need-steps.ts';
import { maskSecrets } from '../windows-steps/service.ts';
import { keptLog, withLostLog } from '../windows-steps/step-log.ts';
import type { ScheduleFolder } from './github.ts';

/** How often the schedules are looked at. */
export const SCHEDULE_TICK_MS = 30_000;
/** How long a claimed run may wait for its saga before it is taken for one a stopped hopper left. */
const BEGIN_GRACE_MS = 60_000;

/** Why a template with minted credentials takes no schedule. */
export const NO_MINT_ON_SCHEDULE = 'a scheduled run gets no minted credential: its template must hold no AWS role, cluster or namespace the vault mints (not built)';

export interface StepSchedulesOptions {
  userId: string;
  repo: StepScheduleRepository;
  /** The user's templates now, as the vault shows them. */
  templates(): TemplateView[];
  /** The folder of a repository at its default branch, read with the user's own connection: the account of the repository. */
  files(repo: string, path: string): Promise<ScheduleFolder>;
  /** A vault secret's value for the run in need box `host` of `template` (the vault's step delivery, after the schedule's grant here). */
  secret?(ask: { name: string; schedule: string; host: string; template: string }): Promise<{ value: string } | { refused: string }>;
  /** Runs the need box (the sandbox module's `needStep`); absent: this hopper runs no sandbox. */
  run?: (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: { log(chunk: string): void; signal: AbortSignal }, run: { jobId: string; step: string; template: string }) => Promise<NeedBoxResult>;
  /** Whether the sandbox runs ledger holds a run of it: its need box started once. */
  ran(run: string): boolean;
  /** The `scheduled-run` saga of a run, begun once; and its abort. Absent: no run starts. */
  sagas?: { begin(run: string): string; abort(saga: string, reason: string): boolean };
  /** Where each run's own directory goes on this machine (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  now?: () => Date;
  newId?: () => string;
  tickMs?: number;
}

export type ScheduleNo = { status: number; no: string };

export interface StepSchedules {
  view(): StepSchedulesView;
  /** One schedule's runs, newest first, with their output; undefined: no such schedule. */
  runs(name: string): StepScheduleRunsView | undefined;
  save(fields: StepScheduleFields, by: string): { schedule: StepScheduleView } | ScheduleNo;
  remove(name: string, by: string): true | ScheduleNo;
  /** A person's vault grant to the schedule (Access decides before, at the route). */
  grant(name: string, by: string): { schedule: StepScheduleView } | ScheduleNo;
  revoke(name: string, by: string): { schedule: StepScheduleView } | ScheduleNo;
  /** Runs it now, once: refused while a run of it has not ended. */
  runNow(name: string, by: string): { run: ScheduledRun } | ScheduleNo;
  /** Claims each due run and begins its saga; ends a claim no saga took. */
  tick(): void;
  /** The saga's `run` step: runs it once, on any host. */
  execute(run: string, signal: AbortSignal): Promise<void>;
  /** The compensation of `run`: a run not ended ends failed. */
  cancel(run: string, reason: string): Promise<void>;
  start(): void;
  stop(): void;
}

/** The template a schedule's run is made of, or why it cannot run now. */
function runnable(t: TemplateView | undefined, s: StepSchedule): { secrets: string[] } | { problem: string } {
  if (!t) return { problem: `template ${s.template} is not there any more` };
  if (boxNeeds(t, undefined).length > 0) return { problem: NO_MINT_ON_SCHEDULE };
  const waits = templateWait(t, `schedule:${s.name}`);
  if (waits) return { problem: `template ${t.name} is not ready now: ${waits}` };
  // Its vault secrets: those the template gives a box step, but a shared secret and the agent credential (issue #1875).
  const secrets = t.gives.filter((n) => !isSharedSecret(n) && n !== t.agentCredential);
  if (secrets.length > 0 && !s.grant) return { problem: `schedule ${s.name} has no vault grant, and template ${t.name} gives ${secrets.join(', ')}: a person grants it with hopper schedule grant ${s.name}` };
  return { secrets };
}

export function createStepSchedules(o: StepSchedulesOptions): StepSchedules {
  const now = o.now ?? (() => new Date());
  const newId = o.newId ?? (() => randomUUID());
  let timer: ReturnType<typeof setInterval> | undefined;

  const viewOf = (s: StepSchedule, last?: ScheduledRun): StepScheduleView => ({ ...s, nextDue: nextDue(s.daily, now()).toISOString(), ...(last ? { lastRun: last } : {}) });
  const view = (): StepSchedulesView => {
    const newest = o.repo.newest();
    const schedules = o.repo.list().map((s) => viewOf(s, newest.get(s.name)));
    return { schedules, failed: failedSchedules(schedules) };
  };
  const missing = (name: string): ScheduleNo => ({ status: 404, no: `no step schedule ${name}` });

  /** Ends the run, once, and records it: `run_finished` for exit 0 with no problem, else `run_failed`. */
  const finish = (r: ScheduledRun, exit: number, problem: string | undefined, seconds: number, interrupted = false): void => {
    const outcome = interrupted ? 'interrupted' : exit === 0 && problem === undefined ? 'succeeded' : 'failed';
    if (!o.repo.end(r.id, { endedAt: now().toISOString(), outcome, exit, ...(problem === undefined ? {} : { problem }) })) return;
    const data = { schedule: r.schedule, run: r.id, exit, seconds, ...(problem === undefined ? {} : { problem }) };
    o.record(outcome === 'succeeded' ? { type: 'step_schedule.run_finished', data } : { type: 'step_schedule.run_failed', data: { ...data, outcome } });
  };

  /** Claims a run of `s` for `due` and begins its saga; undefined: a run of that due time is there, or one has not ended. */
  const claim = (s: StepSchedule, due: string, trigger: ScheduledRunTrigger, by?: string): ScheduledRun | undefined => {
    if (!o.sagas) return undefined;
    const id = newId();
    const run: ScheduledRun = { id, schedule: s.name, due, trigger, ...(by ? { by } : {}), box: `hopper-need-${s.template}-${id.slice(0, 8)}`, startedAt: now().toISOString() };
    if (!o.repo.claim(run)) return undefined;
    const saga = o.sagas.begin(id);
    o.repo.sagaIs(id, saga);
    return { ...run, saga };
  };

  const tick = (): void => {
    const at = now();
    const newest = o.repo.newest();
    for (const r of o.repo.open()) {
      // Claimed by a hopper that stopped before it began the saga: no saga ever runs it.
      if (r.saga === undefined && at.getTime() - Date.parse(r.startedAt) > BEGIN_GRACE_MS) finish(r, 125, 'the hopper stopped before the run began; it is not run again', 0, true);
    }
    for (const s of o.repo.list()) {
      const due = dueNow(s, at);
      const last = newest.get(s.name);
      if (due === undefined || (last && (last.endedAt === undefined || (last.trigger === 'due' && last.due >= due)))) continue;
      claim(s, due, 'due');
    }
    o.repo.sweep(SCHEDULED_RUNS_KEPT);
  };

  const execute = async (id: string, signal: AbortSignal): Promise<void> => {
    const r = o.repo.run(id);
    if (!r || r.endedAt !== undefined) return;
    const startedAt = now().getTime();
    const seconds = () => Math.round((now().getTime() - startedAt) / 1000);
    // Its need box started on a hopper that stopped: never a second time.
    if (o.ran(id)) { finish(r, 125, STEP_INTERRUPTED, 0, true); return; }
    const s = o.repo.get(r.schedule);
    if (!s) { finish(r, 125, `the schedule ${r.schedule} was removed`, 0); return; }
    if (!o.run) { finish(r, 125, 'this hopper runs no sandbox: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")', 0); return; }
    const t = o.templates().find((x) => x.name === s.template);
    const ok = runnable(t, s);
    if ('problem' in ok) { finish(r, 125, ok.problem, 0); return; }
    let folder: ScheduleFolder;
    try { folder = await o.files(s.repo, s.input); } catch (e) { folder = { problem: (e as Error).message }; }
    if ('problem' in folder) { finish(r, 125, `the step's files: ${folder.problem}`, seconds()); return; }
    if (!folder.files.some((f) => f.path === s.script)) { finish(r, 125, `no script ${s.script} in ${s.repo} at its default branch`, seconds()); return; }
    // Read now, for this run only: no secret is kept in the database.
    const secrets: Record<string, string> = {};
    for (const name of ok.secrets) {
      const v = o.secret ? await o.secret({ name, schedule: s.name, host: r.box, template: t!.name }) : { refused: 'the hopper gives no vault secret to a step here' };
      if ('refused' in v) { finish(r, 125, `${name}: ${v.refused}`, seconds()); return; }
      secrets[name] = v.value;
    }
    const dir = join(o.dir, id);
    let inputs: Buffer;
    try {
      inputs = filesTar(folder.files.map((f) => ({ name: f.path, data: f.data, mode: f.executable ? 0o755 : 0o644 })));
    } catch (e) { finish(r, 125, (e as Error).message, seconds()); return; }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'inputs.tar'), inputs, { mode: 0o600 });
    const kept = keptLog((chunk) => o.repo.appendLog(id, chunk), (why) => o.log(`hopper: the output of scheduled run ${id} is not kept from here: ${why}`));
    const masked = maskSecrets(Object.values(secrets), kept.write);
    o.record({ type: 'step_schedule.run_started', data: { schedule: s.name, run: id, due: r.due, trigger: r.trigger, box: r.box, template: t!.name, repo: s.repo, commit: folder.commit, script: s.script, ...(ok.secrets.length ? { secrets: ok.secrets } : {}) } });
    let exit: number, problem: string | undefined;
    try {
      const template = { image: t!.image, ...(t!.tools ? { tools: t!.tools } : {}), ...(t!.egress?.length ? { egress: t!.egress } : {}), ...(t!.readOnly ? { readOnly: true } : {}), ...(t!.limits ? { limits: t!.limits } : {}) };
      const out = await o.run({
        name: r.box, template, env: needEnv({ command: `sh ./${s.script}`, outputs: [], credentials: [] }), timeoutMs: s.timeoutSeconds * 1000, dir,
        files: { inputs: join(dir, 'inputs.tar'), ...(ok.secrets.length ? { secrets } : {}) },
      }, { log: masked.write, signal }, { jobId: `schedule:${s.name}`, step: id, template: t!.name });
      exit = out.exit;
      problem = out.stopped === 'timed-out' || /timed out|did not end/.test(out.problem ?? '') ? `timed out after ${s.timeoutSeconds} s` : out.problem;
    } catch (e) {
      o.log(`hopper: scheduled run ${id} of ${s.name} in ${r.box}: ${(e as Error).message}`);
      exit = 125; problem = (e as Error).message;
    } finally {
      masked.end();
      for (const k of Object.keys(secrets)) delete secrets[k];
      rmSync(dir, { recursive: true, force: true });
    }
    // Its saga aborted, or its hopper stopping: the compensation ends it, or the next host's try does.
    if (signal.aborted) return;
    finish(r, exit, withLostLog({ ...(problem === undefined ? {} : { problem }) }, kept.lost()).problem, seconds());
  };

  return {
    view,
    runs(name) {
      const s = o.repo.get(name);
      if (!s) return undefined;
      const runs = o.repo.runs(name, SCHEDULED_RUNS_KEPT);
      return { schedule: viewOf(s, runs[0]), runs: runs.map((r) => ({ ...r, log: o.repo.log(r.id) })) };
    },
    save(fields, by) {
      const f = { ...fields, input: fields.input.replace(/\/+$/, '') };
      const problem = stepScheduleProblem(f);
      if (problem) return { status: 400, no: problem };
      const t = o.templates().find((x) => x.name === f.template);
      if (!t) return { status: 409, no: `no template ${f.template}: save the template first (hopper template save)` };
      if (boxNeeds(t, undefined).length > 0) return { status: 409, no: NO_MINT_ON_SCHEDULE };
      const was = o.repo.get(f.name);
      // A save that changes what it runs takes its vault grant back: a person grants what it runs now.
      const keep = was?.grant && !changesWhatRuns(was, f) ? { grant: was.grant } : {};
      const s: StepSchedule = { ...f, savedBy: by, savedAt: now().toISOString(), ...keep };
      o.repo.put(s);
      o.record({ type: 'step_schedule.saved', data: { ...f, by, granted: s.grant !== undefined } });
      return { schedule: viewOf(s, o.repo.newest().get(s.name)) };
    },
    remove(name, by) {
      const open = o.repo.open().find((r) => r.schedule === name);
      if (open) return { status: 409, no: `a run of ${name} has not ended: remove it after the run ends` };
      if (!o.repo.remove(name)) return missing(name);
      o.record({ type: 'step_schedule.removed', data: { name, by } });
      return true;
    },
    grant(name, by) {
      const s = o.repo.get(name);
      if (!s) return missing(name);
      const g: StepSchedule = { ...s, grant: { by, at: now().toISOString() } };
      o.repo.put(g);
      o.record({ type: 'step_schedule.granted', data: { name, by, template: s.template } });
      return { schedule: viewOf(g, o.repo.newest().get(name)) };
    },
    revoke(name, by) {
      const s = o.repo.get(name);
      if (!s) return missing(name);
      if (!s.grant) return { status: 409, no: `schedule ${name} has no vault grant` };
      const { grant: _gone, ...rest } = s;
      o.repo.put(rest);
      o.record({ type: 'step_schedule.revoked', data: { name, by } });
      return { schedule: viewOf(rest, o.repo.newest().get(name)) };
    },
    runNow(name, by) {
      const s = o.repo.get(name);
      if (!s) return missing(name);
      if (!o.run || !o.sagas) return { status: 503, no: 'this hopper runs no sandbox: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")' };
      const run = claim(s, now().toISOString(), 'now', by);
      return run ? { run } : { status: 409, no: `a run of ${name} has not ended: it runs one at a time` };
    },
    tick,
    execute,
    async cancel(id, reason) {
      const r = o.repo.run(id);
      if (r) finish(r, 125, `cancelled: ${reason}`, 0);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try { tick(); } catch (e) { o.log(`hopper: the step schedules were not looked at: ${(e as Error).message}`); }
      }, o.tickMs ?? SCHEDULE_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
