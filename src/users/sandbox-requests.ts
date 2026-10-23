// One user's sandbox requests (issue #991, design.md "Sandboxes jobs start"), built from their store and vault: each
// request approved by a person, or by the user's skip sandbox approval, the auto-approve policy or a remembered write
// approval (issue #1001). Approved, the job's box steps run, each in a sandbox of its own (issue #1349). Issue #1471: a
// job's requests are kept from before it starts — the sandboxes its prompt names are asked for then — until it ends.
import { jobBrake } from '../domain/intake-strictness.ts';
import { earlierRuns } from '../domain/rerun-chain.ts';
import { liveWrites, rememberHoursOf } from '../domain/remembered-writes.ts';
import { NO_SKIPS } from '../domain/sandbox-approvals.ts';
import { DEFAULT_SANDBOX_STRICTNESS } from '../domain/sandbox-strictness.ts';
import { outsideStamp } from '../domain/stamp-capabilities.ts';
import type { UserStore } from '../domain/ports.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { Job, MinTrust } from '../domain/types.ts';
import { namedTemplates, sandboxesHold } from '../domain/sandboxes-before-start.ts';
import { createSandboxRequests, type SandboxRequests, type SandboxRequestsOptions } from '../sandbox/requests.ts';
import { DEFAULT_MINOR_DECISION_SETTINGS, type JevFirst } from '../domain/minor-decisions.ts';
import { ALLOW, SANDBOX_CHECK_INSTRUCTIONS, sandboxCheckOptions, sandboxCheckState } from '../domain/sandbox-check.ts';
import type { Sandboxes } from '../sandbox/service.ts';
import type { NeedStepRepository } from '../domain/need-steps.ts';

/**
 * Runs a job's need step or box step (issues #1007, #1349) in a sandbox of its own, burned after it; each step kept in
 * the instance's need steps and run by its `need-step` saga (issue #1568), and whether the sandbox runs ledger
 * holds a run of it.
 */
export interface SandboxLauncher {
  needStep: Sandboxes['needStep'];
  /** Why no step can run for the user now; a container target is offline while it is so (issue #865). */
  stepProblem: Sandboxes['stepProblem'];
  /** "sandbox host <name> is offline" while none of the user's sandbox host is online (issue #2272): a step waits. */
  hostOffline: Sandboxes['hostOffline'];
  steps: NeedStepRepository;
  ran(step: string): boolean;
  /** The need boxes another live hopper runs now, by name (issue #1954): the vault's reconcile pass leaves their tokens bound. */
  elsewhere(): ReadonlySet<string>;
  sagas: { begin(step: string, userId: string): string; abort(saga: string, reason: string): boolean };
}

/** A job not ended: waiting to start (issue #1471), starting, or at work. */
export const LIVE: readonly string[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'waiting_on'];

/** Why the hopper asked for a sandbox before the job started (issue #1471), for the person who approves it. */
export const BEFORE_START_PURPOSE = 'The job\'s brief names this template. The hopper asks for its sandbox runs before the job starts, so the job does not stop mid-run.';

/**
 * Issue #1471, design.md "Sandboxes before the start": for each waiting job not yet started — accepted, of a judged origin
 * and text, not resuming —, ask for the sandbox runs of every template of the user its prompt names, then answer the
 * jobs those requests hold, with why. Asked again, a request is the one the job has: nothing is asked twice.
 */
export function sandboxesHeld(requests: SandboxRequests, templates: () => readonly TemplateView[], waiting: readonly Job[]): { jobId: string; reason: string }[] {
  const toStart = waiting.filter((job) => job.accepted !== false && !job.originPending && !job.textChange && job.pendingAnswer === undefined && typeof job.spec.payload.prompt === 'string');
  if (toStart.length === 0) return [];
  // Read only when a job may name one: the vault's view is not free, and this runs at each Decision.
  const all = templates(), names = all.map((t) => t.name);
  return toStart.flatMap((job) => {
    const named = namedTemplates(job.spec.payload.prompt as string, names);
    if (named.length === 0) return [];
    const reason = sandboxesHold(named.map((t) => requests.ask(job.id, t, { purpose: BEFORE_START_PURPOSE })), all);
    return reason ? [{ jobId: job.id, reason }] : [];
  });
}

/**
 * Jev's `sandbox-request` check (issue #655 part 13) over one user's store: the point's mode read at each ask, and Jev
 * asked with the request, its template, the job's facts and trust, and the job's other requests. In shadow the pick is
 * compared with `allow`, what the approvals did.
 */
function sandboxJev(o: { store: Pick<UserStore, 'settings' | 'jobs'>; templates: () => TemplateView[]; jevFirst: JevFirst }): NonNullable<SandboxRequestsOptions['jev']> {
  const { store } = o;
  return {
    mode: () => ({ ...DEFAULT_MINOR_DECISION_SETTINGS['sandbox-request'], ...store.settings.getMinorDecisionSettings()['sandbox-request'] }).mode,
    ask: ({ request, approver, history, shadow }) => {
      const j = store.jobs.get(request.jobId), level = j ? store.jobs.trustLevel(j) : undefined;
      const template = o.templates().find((t) => t.name === request.template);
      return o.jevFirst.decide({
        point: 'sandbox-request', jobId: request.jobId, instructions: SANDBOX_CHECK_INSTRUCTIONS, options: sandboxCheckOptions(), consequential: [],
        state: sandboxCheckState({ request, ...(template ? { template } : {}), approver, ...(j ? { job: { ...j, ...(level ? { level } : {}), ...(j.stamp ? { reasons: j.stamp.reasons } : {}) } } : {}), history }),
        ...(shadow ? { rules: ALLOW } : {}),
      });
    },
  };
}

export function userSandboxRequests(o: {
  userId: string; store: Pick<UserStore, 'events' | 'settings' | 'jobs'>; templates: () => TemplateView[]; clock: { now(): Date };
  /** Jev, for the `sandbox-request` check (issue #655 part 13); and what lowers a job's trust when Jev denies its run. Absent: no check. */
  jevFirst?: JevFirst; jevDenied?: (jobId: string) => void;
  /** Each operation profile's minimum trust in Access (issue #655 parts 15, 16): what a job's stamp may ask for. Absent: none. */
  minTrusts?: () => MinTrust[];
}): SandboxRequests {
  const { store } = o;
  return createSandboxRequests({
    ...(o.jevFirst ? { jev: sandboxJev({ store, templates: o.templates, jevFirst: o.jevFirst }) } : {}),
    ...(o.jevDenied ? { jevDenied: o.jevDenied } : {}),
    record: (e) => { store.events.append(e); },
    approvals: () => store.settings.getSandboxApprovals() ?? NO_SKIPS,
    template: (name) => o.templates().find((t) => t.name === name),
    live: (id) => LIVE.includes(store.jobs.get(id)?.status ?? ''),
    // Issue #655 parts 7 and 12: below approved, or below the intake strictness on it now, a person approves.
    autoApprovable: (id) => { const j = store.jobs.get(id); return j !== undefined && store.jobs.gate2Hold(j, jobBrake(store.settings.getIntakeStrictness(), j)) === undefined; },
    // Issue #655 part 16: a need above the job's trust, as its stamp verifies now, is outside the stamp.
    outsideStamp: (id, profiles) => { const j = store.jobs.get(id); return outsideStamp(j ? store.jobs.trustLevel(j) : undefined, profiles, o.minTrusts?.() ?? []); },
    strictness: () => store.settings.getSandboxStrictness() ?? DEFAULT_SANDBOX_STRICTNESS, // issue #655 part 8, brake 2
    jobTitle: (id) => { const j = store.jobs.get(id); return j?.source?.title ?? j?.spec.goal; },
    jobUrl: (id) => store.jobs.get(id)?.source?.url,
    // Issue #2639 part 2: a person's approval of a run carries to the jobs that run its job again.
    earlier: (id) => earlierRuns(id, (x) => store.jobs.get(x)),
    // Issue #1001: a person's remembered write approvals, and the read policy for the reads beside them.
    remembered: () => liveWrites(store.settings.getRememberedWrites(), rememberHoursOf(store.settings.getSandboxApprovals()), o.clock.now()),
    policy: () => store.settings.getReadPolicy(),
    clock: o.clock,
  });
}


/** How often the hopper looks for a request no person answered in time (issue #655 part 9). */
export const HOLD_SWEEP_MS = 60_000;

/**
 * Issue #655 part 9: declines each request that waited too long for a person, once a minute, so a job that waits on it
 * is woken with the decline (`vault.sandbox_declined`) even when nobody opens the Vault page.
 */
export function holdSweep(requests: Pick<SandboxRequests, 'expire'>): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() { if (timer) return; timer = setInterval(() => { requests.expire(); }, HOLD_SWEEP_MS); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
