// Sandbox requests (issue #991, design.md "Sandboxes jobs start"): a running job asks the hopper for sandbox runs of the
// template its needs made (`sh "$HOPPER_SKILL" sandbox --needs …`). One user's requests, kept in memory, one per job and
// template: asked again, the job is told where its request is. A request waits for a person on Access requests unless
// the user's **skip sandbox approval** is on; then it is approved at once, by that toggle. Approved, the job runs its
// commands as box steps: each in a sandbox of its own, of the template, that the hopper burns after the step (issue
// #1349, src/sandbox/need-box.ts). The approval starts nothing: no box waits between steps, and none joins as a machine.
// Every step is an event on the job's timeline. A person declines a request with a reason the job is told. A request
// whose job ended is forgotten. Issue #1471: the hopper asks for the sandboxes a job's prompt names before it starts.
// Issue #1001: a run needs no separate approval when the user's auto-approve policy holds its template's blast radius,
// or when a person approved the template this job asked for, or waited on: that approval was given for this job's run;
// or when a person's remembered write approvals cover every change the template makes (src/domain/remembered-writes.ts).
// A request keeps the job's purpose, its plan and its link, for the person who decides. Issue #655 part 7: a job whose
// trust stamp is below `approved` gets no run with no person: its request waits, whatever the toggles and policies say.
// Issue #655 part 8: sandbox strictness (brake 2) asks a person for each run of a template it holds, the same way; tightened,
// a run approved before with no person no longer counts (`runnable`). Issue #655 part 9: a request no person answered
// within 24 hours is declined by the hopper (`HOLD_TIMEOUT`), for this request only: the job's trust stays. Issue #655
// part 13: where the approvals would approve a run with no person and sandbox strictness is `standard` for a template not
// of low blast radius, Jev's `sandbox-request` check reads it first. Active, the request waits for Jev: allow approves it
// (`JEV_APPROVER`), hold leaves it for a person, deny declines it and lowers the job's trust; no sure pick holds it.
// Issue #655 part 16: before all of that, a run of a template with a profile whose minimum trust the job's stamp does not
// meet is declined at once by the minimum trust (`MIN_TRUST_DECLINER`), and lowers no trust; set later, it stops the run.
// Issue #2197: each ask of a job that waits on a template for a person is kept too (`waits`), with the job's words, so
// it shows as one run card; a person who declines that card declines the job's run of the template before it is asked.
// Each new run card is one `vault.run_card_opened` on the job's timeline, which the notifiers send (part 2): when a run
// waits for a person (not while Jev reads it), or an ask waits on a template for a person; once per job and template.
// Issue #2639 part 2: a person's approval of a job's runs of a template carries to the jobs that run it again (`earlier`):
// a rerun's run of the same template is approved at once, by that approval, when its trust lets a run go with no person.
// The approvals of a job that ended are kept for that (`KEPT`, the newest), in memory as the requests are.
import { randomUUID } from 'node:crypto';
import type { MinorDecisionMode, MinorDecisionOutcome } from '../domain/minor-decisions.ts';
import { checkedVerdict, jevChecks, sandboxCheckText, type SandboxHistoryItem } from '../domain/sandbox-check.ts';
import {
  AUTO_APPROVER, autoApproves, carriedApprovalBy, HOLD_TIMEOUT, JEV_APPROVER, NO_PERSON, SANDBOX_HOLD_MS, SKIP_SANDBOX_APPROVER, templateApprovalBy, type SandboxApprovals, type SandboxRequestView,
} from '../domain/sandbox-approvals.ts';
import { readApprovedWithoutPerson, REMEMBERED_APPROVER, rememberedCovers, type RememberedWrite } from '../domain/remembered-writes.ts';
import type { ReadPolicy } from '../domain/read-policy.ts';
import { MIN_TRUST_DECLINER } from '../domain/stamp-capabilities.ts';
import { DEFAULT_SANDBOX_STRICTNESS, personBrake, type SandboxStrictness } from '../domain/sandbox-strictness.ts';
import { waitsForPerson, type TemplateWait } from '../domain/run-cards.ts';
import type { NewEvent, OperationProfile } from '../domain/types.ts';
import { approvalCovers, type TemplateView } from '../domain/vault.ts';

export interface SandboxRequestsOptions {
  record(event: NewEvent): void;
  approvals(): SandboxApprovals;
  template(name: string): TemplateView | undefined;
  /** Whether the job has not ended (issue #1471: a job waiting to start too): a request of a job that ended is forgotten. */
  live(jobId: string): boolean;
  /** Whether a run of the job may be approved with no person (issue #655 part 7: its trust stamp is `approved` or above). Absent: yes. */
  autoApprovable?(jobId: string): boolean;
  /**
   * Why `profiles` are outside the job's trust stamp (issue #655 part 16): one has a minimum trust its level does not meet.
   * Read at each ask and each `runnable`. Absent: none is.
   */
  outsideStamp?(jobId: string, profiles: readonly OperationProfile[]): string | undefined;
  /** Sandbox strictness, brake 2 (issue #655 part 8), read at each ask. Absent: standard, so the toggles decide. */
  strictness?(): SandboxStrictness;
  jobTitle?(jobId: string): string | undefined;
  /** The jobs `jobId` runs again, newest first (issue #2639 part 2, src/domain/rerun-chain.ts). Absent: none. */
  earlier?(jobId: string): string[];
  /** The job's issue or pull request (issue #1001). */
  jobUrl?(jobId: string): string | undefined;
  /** A person's write approvals the hopper remembers now (issue #1001), ended ones left out; absent: none. */
  remembered?(): RememberedWrite[];
  /** The read policy: with the auto-approve policy, whether a read in a template remembered approvals cover needs a person. */
  policy?(): ReadPolicy | undefined;
  /**
   * Jev's `sandbox-request` check (issue #655 part 13): the point's mode now, and Jev asked about a request the approvals
   * would approve with no person (`approver`), with the job's other requests. `shadow`: only recorded. Absent: off.
   */
  jev?: {
    mode(): MinorDecisionMode;
    ask(a: { request: SandboxRequestView; approver: string; history: SandboxHistoryItem[]; shadow: boolean }): Promise<MinorDecisionOutcome>;
  };
  /** Jev denied a run of the job (part 13): its trust is lowered, as at a person's deny. */
  jevDenied?(jobId: string): void;
  clock: { now(): Date };
  newId?: () => string;
}

const HOLD_REASON = `no person answered it within ${SANDBOX_HOLD_MS / 3_600_000} hours`;

/** How many runs of jobs that ended a person approved are kept for their reruns (issue #2639 part 2). */
export const KEPT = 500;

/** Whether `by` is a person: a run one approved counts while its job runs, whatever its trust is now. */
const person = (by: string | undefined): boolean => by !== undefined && !NO_PERSON.includes(by);

export type SandboxRequestResult = { ok: true } | { ok: false; code: 'not_found' | 'conflict'; error: string };

export interface SandboxRequests {
  /**
   * The job's request for a box of the template: the one it has, else a new one (approved at once when the toggle says
   * so). `about` (issue #1001): why the job asks and its plan, kept on a new request.
   */
  ask(jobId: string, template: string, about?: { purpose: string; plan?: string }): SandboxRequestView;
  /**
   * The job waited on the template for a person's approval (issue #1001): that approval covers the job's run. Kept with
   * the job's words for its run card (issue #2197). Answers the job's run of the template when a person declined it.
   */
  waited(jobId: string, template: string, about?: { purpose: string; plan?: string }): SandboxRequestView | undefined;
  /** The asks of jobs not ended that waited on a template for a person (issue #2197), oldest first. */
  waits(): TemplateWait[];
  /**
   * A person declines the job's run of the template (issue #2197): its waiting request, else a declined one made now, so
   * the job's ask that waits on the template is told no.
   */
  declineRun(jobId: string, template: string, reason: string, by: string): SandboxRequestResult;
  /** A person approves a waiting request: the job's box steps run. */
  approve(id: string, by: string): SandboxRequestResult;
  /** A person declines a waiting request, with the reason the job is told. */
  decline(id: string, reason: string, by: string): SandboxRequestResult;
  /** The requests of jobs not ended, oldest first. */
  list(): SandboxRequestView[];
  /**
   * The templates of the job's approved requests that count now: the boxes its box steps may name (issue #1349). One
   * approved with no person counts only while the job and the brake still let it (issue #655 parts 7 and 8).
   */
  runnable(jobId: string): string[];
  /** Why `profiles` are outside the job's trust stamp (issue #655 part 16), asked before a template is made for them; undefined: inside. */
  outside(jobId: string, profiles: readonly OperationProfile[]): string | undefined;
  /** Declines each request that waited `SANDBOX_HOLD_MS` for a person, by `HOLD_TIMEOUT` (issue #655 part 9); how many. */
  expire(): number;
}

export function createSandboxRequests(o: SandboxRequestsOptions): SandboxRequests {
  const newId = o.newId ?? (() => randomUUID());
  const requests = new Map<string, SandboxRequestView>();
  /** `<job> <template>`: the templates each job at work waited on for a person (issue #1001), with its ask (issue #2197). */
  const waitedOn = new Map<string, TemplateWait>();
  /** `<job> <template>`: the run cards opened (issue #2197), so each card is one notice. */
  const opened = new Set<string>();
  /** `<job> <template>`: the runs of jobs that ended a person approved (issue #2639 part 2), oldest first. */
  const kept = new Set<string>();
  const keep = (r: SandboxRequestView): void => {
    if (r.state !== 'approved' || !person(r.approvedBy)) return;
    kept.add(`${r.jobId} ${r.template}`);
    for (const k of kept) { if (kept.size <= KEPT) break; kept.delete(k); }
  };
  const open = (jobId: string, template: string, waits: { template: boolean; run: boolean }, purpose?: string): void => {
    const key = `${jobId} ${template}`;
    if (opened.has(key)) return;
    opened.add(key);
    o.record({ type: 'vault.run_card_opened', jobId, data: { template, waits, ...(purpose ? { purpose } : {}) } });
  };
  const templateWaits = (name: string, jobId: string): boolean => { const t = o.template(name); return t !== undefined && waitsForPerson(t, jobId); };
  const event = (r: SandboxRequestView, type: NewEvent['type'], data: Record<string, unknown> = {}): void => {
    o.record({ type, jobId: r.jobId, data: { request: r.id, template: r.template, ...data } });
  };

  const decline = (r: SandboxRequestView, reason: string, by: string): void => {
    delete r.jev;
    r.state = 'declined';
    r.reason = reason;
    r.declinedBy = by;
    event(r, 'vault.sandbox_declined', { reason, by });
  };

  const expire = (): number => {
    const due = o.clock.now().getTime() - SANDBOX_HOLD_MS;
    const overdue = [...requests.values()].filter((r) => r.state === 'waiting' && Date.parse(r.askedAt) <= due);
    for (const r of overdue) decline(r, HOLD_REASON, HOLD_TIMEOUT);
    return overdue.length;
  };

  /** The requests of jobs that ended forgotten, and the overdue ones declined: how many were declined. */
  const forget = (): number => {
    for (const [id, r] of requests) if (!o.live(r.jobId)) { keep(r); requests.delete(id); }
    for (const [k, w] of waitedOn) if (!o.live(w.jobId)) waitedOn.delete(k);
    for (const k of opened) if (!o.live(k.slice(0, k.indexOf(' ')))) opened.delete(k);
    return expire();
  };

  /**
   * Who approves the job's run with no second person, or undefined: skip sandbox approval; the auto-approve policy, for
   * the template's radius; a person's remembered write approvals that cover the template (issue #1001); a person's
   * approval of the template the job asked for or waited on.
   */
  /** Why a run of the job's `template` is outside its trust stamp (issue #655 part 16); undefined: inside, or no such template. */
  const outside = (jobId: string, template: string): string | undefined => o.outsideStamp?.(jobId, o.template(template)?.profiles ?? []);

  /** Whether a run of the job's `template` may be approved with no person: its trust stamp and the brake let it. */
  const withNoPerson = (jobId: string, template: string): boolean =>
    o.autoApprovable?.(jobId) !== false && !(o.strictness && personBrake(o.strictness(), o.template(template)));

  /** The newest job `jobId` runs again whose run of `template` a person approved (issue #2639 part 2), if one did. */
  const carriedFrom = (jobId: string, template: string): string | undefined => (o.earlier?.(jobId) ?? []).find((id) =>
    kept.has(`${id} ${template}`) || [...requests.values()].some((r) => r.jobId === id && r.template === template && r.state === 'approved' && person(r.approvedBy)));

  const approverOf = (jobId: string, template: string): { by: string; radius?: string } | undefined => {
    if (!withNoPerson(jobId, template)) return undefined;
    if (o.approvals().skipSandboxApproval) return { by: SKIP_SANDBOX_APPROVER };
    const t = o.template(template);
    if (!t) return undefined;
    if (autoApproves(o.approvals(), t.radius?.level)) return { by: AUTO_APPROVER, radius: t.radius.level };
    const carried = carriedFrom(jobId, template);
    if (carried) return { by: carriedApprovalBy(carried) };
    if (o.remembered && rememberedCovers({ secrets: t.secrets ?? [], profiles: t.profiles ?? [] }, o.remembered(), readApprovedWithoutPerson(o.policy?.(), o.approvals()))) return { by: REMEMBERED_APPROVER };
    const person = t.approval?.by;
    // Issue #2197 part 3: and only when that approval covers the job's runs.
    const forJob = (t.askedBy === jobId || waitedOn.has(`${jobId} ${template}`)) && approvalCovers(t, jobId);
    return person && !NO_PERSON.includes(person) && forJob ? { by: templateApprovalBy(person) } : undefined;
  };

  const approve = (r: SandboxRequestView, by: string, data: Record<string, unknown> = {}): void => {
    r.state = 'approved';
    r.approvedBy = by;
    delete r.jev;
    event(r, 'vault.sandbox_approved', { by, ...data });
  };

  /** Jev's mode for a run of `template` the approvals would approve: off unless the brake is `standard` and its radius not low. */
  const jevMode = (template: string): MinorDecisionMode =>
    o.jev && jevChecks(o.strictness?.() ?? DEFAULT_SANDBOX_STRICTNESS, o.template(template)) ? o.jev.mode() : 'off';

  /**
   * Jev asked about `r`, which `approver` would approve. In shadow only recorded. Active, applied while it still waits on
   * Jev (a person's answer first wins): allow approves it, if the approvals still would; hold leaves it for a person; deny
   * declines it and lowers the job's trust. No sure pick holds it (fail closed).
   */
  const check = async (r: SandboxRequestView, approver: { by: string; radius?: string }, shadow: boolean): Promise<void> => {
    const history = [...requests.values()].filter((x) => x.jobId === r.jobId && x.id !== r.id)
      .map((x) => ({ template: x.template, state: x.state, askedAt: x.askedAt, ...(x.approvedBy ?? x.declinedBy ? { by: x.approvedBy ?? x.declinedBy } : {}) }));
    const out = await o.jev!.ask({ request: { ...r }, approver: approver.by, history, shadow })
      .catch((): MinorDecisionOutcome => ({ asked: true, pickId: '', applied: false, notApplied: 'no_pick' }));
    if (shadow || requests.get(r.id) !== r || r.state !== 'waiting' || r.jev?.state !== 'checking') return;
    const v = checkedVerdict(out);
    if (v.verdict === 'deny') {
      decline(r, sandboxCheckText(v.reason), JEV_APPROVER);
      o.jevDenied?.(r.jobId);
    } else if (v.verdict === 'allow' && approverOf(r.jobId, r.template)) approve(r, JEV_APPROVER, approver.radius ? { radius: approver.radius } : {});
    else {
      r.jev = { state: 'held', ...(v.verdict === 'hold' ? { reason: sandboxCheckText(v.reason) } : {}) };
      open(r.jobId, r.template, { template: templateWaits(r.template, r.jobId), run: true }, r.purpose);
    }
  };

  const waiting = (id: string): SandboxRequestView | SandboxRequestResult => {
    const r = requests.get(id);
    if (!r) return { ok: false, code: 'not_found', error: `no sandbox request ${id}` };
    if (r.state !== 'waiting') return { ok: false, code: 'conflict', error: `sandbox request ${id} is ${r.state}, not waiting` };
    return r;
  };

  return {
    ask(jobId, template, about) {
      forget();
      const had = [...requests.values()].find((r) => r.jobId === jobId && r.template === template);
      if (had) return { ...had };
      const title = o.jobTitle?.(jobId), url = o.jobUrl?.(jobId);
      const r: SandboxRequestView = {
        id: newId(), jobId, ...(title ? { jobTitle: title } : {}), ...(url ? { jobUrl: url } : {}), template, state: 'waiting', askedAt: o.clock.now().toISOString(),
        ...(about ? { purpose: about.purpose, ...(about.plan ? { plan: about.plan } : {}) } : {}),
      };
      requests.set(r.id, r);
      event(r, 'vault.sandbox_requested');
      const out = outside(jobId, template);
      if (out) {
        decline(r, out, MIN_TRUST_DECLINER);
        return { ...r };
      }
      const approver = approverOf(jobId, template);
      const m = approver ? jevMode(template) : 'off';
      if (approver && m === 'active') {
        r.jev = { state: 'checking' };
        void check(r, approver, false);
      } else if (approver) {
        approve(r, approver.by, approver.radius ? { radius: approver.radius } : {});
        if (m === 'shadow') void check(r, approver, true);
      } else open(jobId, template, { template: templateWaits(template, jobId), run: true }, about?.purpose);
      return { ...r };
    },
    waited(jobId, template, about) {
      const key = `${jobId} ${template}`;
      if (!waitedOn.has(key)) {
        waitedOn.set(key, { jobId, template, ...(about ? { purpose: about.purpose, ...(about.plan ? { plan: about.plan } : {}) } : {}), askedAt: o.clock.now().toISOString() });
      }
      const declined = [...requests.values()].find((r) => r.jobId === jobId && r.template === template && r.state === 'declined');
      if (!declined && templateWaits(template, jobId)) open(jobId, template, { template: true, run: false }, waitedOn.get(key)!.purpose);
      return declined ? { ...declined } : undefined;
    },
    waits() {
      forget();
      return [...waitedOn.values()].map((w) => ({ ...w }));
    },
    declineRun(jobId, template, reason, by) {
      forget();
      const had = [...requests.values()].find((r) => r.jobId === jobId && r.template === template);
      if (had && had.state !== 'waiting') return { ok: false, code: 'conflict', error: `the sandbox runs of template ${template} for job ${jobId} are ${had.state}, not waiting` };
      if (had) {
        decline(had, reason, by);
        return { ok: true };
      }
      const w = waitedOn.get(`${jobId} ${template}`);
      if (!w) return { ok: false, code: 'not_found', error: `job ${jobId} waits on no template ${template}` };
      const title = o.jobTitle?.(jobId), url = o.jobUrl?.(jobId);
      const r: SandboxRequestView = {
        id: newId(), jobId, ...(title ? { jobTitle: title } : {}), ...(url ? { jobUrl: url } : {}), template, state: 'waiting', askedAt: w.askedAt,
        ...(w.purpose ? { purpose: w.purpose } : {}), ...(w.plan ? { plan: w.plan } : {}),
      };
      requests.set(r.id, r);
      decline(r, reason, by);
      return { ok: true };
    },
    approve(id, by) {
      const r = waiting(id);
      if ('ok' in r) return r;
      approve(r, by);
      return { ok: true };
    },
    decline(id, reason, by) {
      const r = waiting(id);
      if ('ok' in r) return r;
      decline(r, reason, by);
      return { ok: true };
    },
    list() {
      forget();
      return [...requests.values()].map((r) => ({ ...r }));
    },
    runnable(jobId) {
      return [...requests.values()]
        .filter((r) => r.jobId === jobId && r.state === 'approved' && (person(r.approvedBy) || withNoPerson(jobId, r.template)) && !outside(jobId, r.template))
        .map((r) => r.template);
    },
    outside: (jobId, profiles) => o.outsideStamp?.(jobId, profiles),
    expire: forget,
  };
}

