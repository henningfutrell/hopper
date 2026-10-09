// Access (issue #559, design.md "Access: OpenFGA decides each mint"): the decision point the vault (issue #558) asks
// before every credential it mints or renews — `decideMint` —, the approvals and the model the hopper keeps and pushes
// to OpenFGA, and Settings → Access's view. Fail closed: with no OpenFGA set up, OpenFGA not reached, a change it has
// not taken yet, a model it refused, or a job that is not live, the answer is a deny, recorded like any other. Each
// template shows with its blast radius (issue #584), rated from its approvals and the vault templates of that name.
import { randomUUID } from 'node:crypto';
import { isRefusal, type AccessRepository, type AuthorizationServer, type Clock, type RelationshipTuple, type StoredTuple } from '../domain/ports.ts';
import { rateTemplate, type TemplateScope } from '../blast-radius/template.ts';
import {
  DEFAULT_BLAST_RADIUS_SETTINGS, profileProblem, RADIUS_LEVELS, TEMPLATE_NAME,
  type RadiusRules, type TemplateApprovals, type TemplateRadius,
  type AccessDecisionRecord, type AccessHolders, type AccessModelView, type AccessStatus, type AccessView, type Approval, type MintDecision, type MintRequest,
  type OperationProfile, type RevokedApproval, type Asset,
} from '../domain/types.ts';
import { compileAccessModel, DEFAULT_ACCESS_MODEL, modelGaps, type ModelJson } from './model.ts';
import { approvalTuples, jobObject, profileOf, relationshipPath, runningTuple, assetObject } from './objects.ts';

/** A job is live while it is claimed, running or waiting on an answer: parked, operator-led, ended or not yet started, it gets nothing. */
export const LIVE_JOB_STATUSES: readonly string[] = ['claimed', 'running', 'waiting_answer'];
/** How often everything is pushed again: drift in OpenFGA is put back, and an OpenFGA come back is found. */
export const ACCESS_SYNC_MS = 30_000;
const STORE_NAME = 'hopper';
const DECISIONS_SHOWN = 50;
const REVOKED_SHOWN = 20;
export const NOT_CONFIGURED = 'OpenFGA is not set up: set HOPPER_OPENFGA_URL (docs/deploy.md "Access: OpenFGA")';

/** What an edit refused: 400 (not valid), 404 (no such approval) or 409 (the model changed since it was read). */
export class AccessEditError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Access extends TemplateApprovals {
  /** Allowed or denied, why, and the relationship path; recorded. The vault calls it before every mint and renewal. */
  decideMint(request: MintRequest): Promise<MintDecision>;
  /** A check for a made-up live job of `template`, tried from Settings → Access; recorded as a trial by `by`. */
  tryCheck(request: Omit<MintRequest, 'job'>, by: string): Promise<AccessDecisionRecord>;
  /** The template approved for the operation profile (the vault's gate writes this, issue #558); pushed at once. */
  approve(template: string, profile: OperationProfile, by: string): Promise<void>;
  revoke(approval: number, by: string): Promise<void>;
  /** A new model, against the version read; OpenFGA must take it when it can be asked. */
  setModel(dsl: string, version: number, by: string): Promise<void>;
  /** Push the model and every approval to OpenFGA, putting back what differs; resolves when done or failed (the status says which). */
  sync(): Promise<void>;
  view(): AccessView;
  start(): void;
  stop(): void;
}

export interface AccessOptions {
  repo: AccessRepository;
  /** OpenFGA, or undefined while none is set up. */
  server: AuthorizationServer | undefined;
  clock: Clock;
  /** A job's status, or undefined when the user has no such job. */
  jobStatus(userId: string, jobId: string): string | undefined;
  logger: { warn(line: string): void };
  syncMs?: number;
  /** Every user's vault templates (issue #584), each with that user's blast-radius rules: what a template's rating reads beside its approvals. */
  templates?: () => { name: string; scope: TemplateScope; rules: RadiusRules }[];
  /** Every user's machines of a template and live jobs on them (the permission matrix's rows); none when absent. */
  holders?: () => AccessHolders;
}

const KEY_STORE = 'storeId';
const KEY_PUSHED = 'pushedModel';
const SYSTEM = 'hopper';

const tupleKey = (t: RelationshipTuple) => `${t.subject} ${t.relation} ${t.object}`;
const plain = (t: StoredTuple): RelationshipTuple => ({ subject: t.subject, relation: t.relation, object: t.object });
const describeAsset = (t: Asset) => `${t.kind} ${t.name}`;
const rank = (r: TemplateRadius): number => RADIUS_LEVELS.indexOf(r.level);

/** Why a request names no template, operation or asset the model can hold, or undefined. */
export function requestProblem(r: { template: string; operation: string; asset: { kind: string; name: string } }): string | undefined {
  if (!TEMPLATE_NAME.test(r.template)) return `template ${JSON.stringify(r.template)} is not a template name (lowercase letters, digits, . _ -)`;
  return profileProblem(r);
}

export function createAccess(o: AccessOptions): Access {
  const now = () => o.clock.now().toISOString();
  let status: AccessStatus = o.server ? { state: 'unreachable', why: 'not asked yet' } : { state: 'not-configured', why: NOT_CONFIGURED };
  // Something in the database OpenFGA may not hold yet: nothing is asked of OpenFGA until it is pushed.
  let dirty = true;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const model = (): AccessModelView => {
    const m = o.repo.model() ?? o.repo.addModel(DEFAULT_ACCESS_MODEL, SYSTEM, now());
    return { version: m.seq, dsl: m.dsl, writtenBy: m.writtenBy, writtenAt: m.writtenAt };
  };
  const pushedModel = (): { storeId: string; version: number; modelId: string } | undefined => {
    const raw = o.repo.state(KEY_PUSHED);
    return raw ? JSON.parse(raw) as { storeId: string; version: number; modelId: string } : undefined;
  };

  /** OpenFGA cannot be asked: said in the log once per reason, and in the status. */
  const down = (why: string): void => {
    if (status.state !== 'unreachable' || status.why !== why) o.logger.warn(`hopper: access: OpenFGA cannot be asked, so every mint is denied: ${why}`);
    status = { state: 'unreachable', why, ...(status.storeId ? { storeId: status.storeId } : {}) };
  };

  const push = async (server: AuthorizationServer): Promise<void> => {
    const storeId = await server.store(o.repo.state(KEY_STORE), STORE_NAME);
    if (storeId !== o.repo.state(KEY_STORE)) o.repo.setState(KEY_STORE, storeId);
    const m = model();
    let pushed = pushedModel();
    if (pushed?.storeId !== storeId || pushed.version !== m.version) {
      const modelId = await server.writeModel(storeId, compileAccessModel(m.dsl));
      pushed = { storeId, version: m.version, modelId };
      o.repo.setState(KEY_PUSHED, JSON.stringify(pushed));
    }
    const want = new Map(o.repo.liveTuples().map((t) => [tupleKey(t), plain(t)]));
    const have = new Map((await server.tuples(storeId)).map((t) => [tupleKey(t), t]));
    const writes = [...want].filter(([k]) => !have.has(k)).map(([, t]) => t);
    const deletes = [...have].filter(([k]) => !want.has(k)).map(([, t]) => t);
    if (writes.length + deletes.length > 0) await server.write(storeId, pushed.modelId, { writes, deletes });
    status = { state: 'connected', syncedAt: now(), storeId, modelId: pushed.modelId };
  };

  const sync = (): Promise<void> => {
    const server = o.server;
    if (!server) return Promise.resolve();
    // One push at a time; a change made while one runs is pushed by the next.
    running ??= (async () => {
      dirty = false;
      try {
        await push(server);
      } catch (e) {
        dirty = true;
        down(isRefusal(e) ? `OpenFGA refused what the hopper pushed: ${(e as Error).message}` : (e as Error).message);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const changed = async (): Promise<void> => {
    dirty = true;
    await running;
    await sync();
  };

  const record = (d: Omit<AccessDecisionRecord, 'id' | 'at'>): AccessDecisionRecord => {
    const full: AccessDecisionRecord = { id: randomUUID(), at: now(), ...d };
    o.repo.recordDecision(full);
    return full;
  };

  /** OpenFGA's answer for `job` running from the template, once everything is pushed; a deny when it cannot be had. */
  const ask = async (job: string, r: Omit<MintRequest, 'job'>): Promise<Pick<MintDecision, 'allowed' | 'reason' | 'path' | 'modelId'>> => {
    const server = o.server;
    if (!server) return { allowed: false, reason: NOT_CONFIGURED };
    if (dirty) { await running; await sync(); }
    if (dirty) return { allowed: false, reason: `OpenFGA cannot be asked: ${status.why ?? 'unknown'}` };
    const pushed = pushedModel()!;
    const profile = { operation: r.operation, asset: r.asset };
    try {
      const allowed = await server.check(pushed.storeId, pushed.modelId,
        { subject: job, relation: `can_${r.operation}`, object: assetObject(r.asset) }, [runningTuple(job, r.template)]);
      if (!allowed) return { allowed, modelId: pushed.modelId, reason: `template ${r.template} is not approved to ${r.operation} on ${describeAsset(r.asset)}` };
      const path = relationshipPath(o.repo.liveTuples().map(plain), job, r.template, profile);
      return { allowed, modelId: pushed.modelId, reason: `template ${r.template} is approved to ${r.operation} on ${describeAsset(r.asset)}`, ...(path ? { path } : {}) };
    } catch (e) {
      dirty = true;
      down((e as Error).message);
      return { allowed: false, reason: `OpenFGA cannot be asked: ${(e as Error).message}` };
    }
  };

  const approvalOf = (approval: StoredTuple): Approval | undefined => {
    const id = approval.object.replace(/^operation_profile:/, '');
    const profile = profileOf(id);
    if (!profile || !approval.subject.startsWith('template:')) return undefined;
    const template = approval.subject.slice('template:'.length);
    const { grant } = approvalTuples(template, profile);
    return { id: approval.seq, template, profile, approvedBy: approval.writtenBy, approvedAt: approval.writtenAt, chain: [plain(approval), grant] };
  };

  const approvals = (): Approval[] =>
    o.repo.liveTuples().filter((t) => t.relation === 'approved_for').map(approvalOf).filter((a): a is Approval => a !== undefined);

  /** A template's rating: from its approvals and each vault template of its name; the highest when users' templates share it. */
  const radiusOf = (template: string, approved: OperationProfile[], scopes: { name: string; scope: TemplateScope; rules: RadiusRules }[]): TemplateRadius => {
    const mine = scopes.filter((s) => s.name === template);
    const rated = mine.length ? mine.map((s) => rateTemplate(s.scope, approved, s.rules)) : [rateTemplate({ secrets: [], profiles: [] }, approved, DEFAULT_BLAST_RADIUS_SETTINGS.rules)];
    return rated.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  };

  return {
    approvedProfiles: (template) => approvals().filter((a) => a.template === template).map((a) => a.profile),
    async revokeProfile(template, profile, by) {
      const { approval } = approvalTuples(template, profile);
      const live = o.repo.liveTuples().find((t) => t.relation === 'approved_for' && t.subject === approval.subject && t.object === approval.object);
      if (!live || !o.repo.revokeTuple(live.seq, by, now())) return;
      await changed();
    },
    async decideMint(request) {
      const { job, template, operation, asset } = request;
      const base = { job: { userId: job.userId, jobId: job.jobId }, template, operation, asset };
      const problem = requestProblem(request);
      if (problem) return record({ ...base, allowed: false, reason: `not a request the model can hold: ${problem}` });
      const jobStatus = o.jobStatus(job.userId, job.jobId);
      if (jobStatus === undefined || !LIVE_JOB_STATUSES.includes(jobStatus)) {
        return record({ ...base, allowed: false, reason: `job ${job.jobId} is not live (${jobStatus ?? 'no such job'})` });
      }
      return record({ ...base, ...await ask(jobObject(job), request) });
    },
    async tryCheck(request, by) {
      const problem = requestProblem(request);
      if (problem) throw new AccessEditError(400, problem);
      const { template, operation, asset } = request;
      return record({ trial: { by }, template, operation, asset, ...await ask(`job:trial/${randomUUID()}`, request) });
    },
    async approve(template, profile, by) {
      const problem = requestProblem({ template, ...profile });
      if (problem) throw new AccessEditError(400, problem);
      const { grant, approval } = approvalTuples(template, profile);
      const at = now();
      o.repo.addTuple(grant, by, at);
      o.repo.addTuple(approval, by, at);
      await changed();
    },
    async revoke(id, by) {
      const live = o.repo.liveTuples().find((t) => t.seq === id && t.relation === 'approved_for');
      if (!live || !o.repo.revokeTuple(id, by, now())) throw new AccessEditError(404, `no approval ${id}: it was revoked already, or never was`);
      await changed();
    },
    async setModel(dsl, version, by) {
      if (model().version !== version) throw new AccessEditError(409, 'the model changed since it was read: read it again');
      let json: ModelJson;
      try { json = compileAccessModel(dsl); } catch (e) { throw new AccessEditError(400, `the model does not parse: ${(e as Error).message}`); }
      const gaps = modelGaps(json);
      if (gaps.length > 0) throw new AccessEditError(400, `the model lacks what the hopper writes or asks: ${gaps.join(', ')}`);
      // OpenFGA checks a model further than the DSL: when it can be asked, it must take this one first.
      const storeId = o.repo.state(KEY_STORE);
      let modelId: string | undefined;
      if (o.server && storeId && status.state === 'connected') {
        try {
          modelId = await o.server.writeModel(storeId, json);
        } catch (e) {
          if (isRefusal(e)) throw new AccessEditError(400, `OpenFGA refused the model: ${(e as Error).message}`);
        }
      }
      const saved = o.repo.addModel(dsl, by, now());
      if (storeId && modelId) o.repo.setState(KEY_PUSHED, JSON.stringify({ storeId, version: saved.seq, modelId }));
      await changed();
    },
    sync: async () => { await running; await sync(); },
    view() {
      const all = approvals();
      const scopes = o.templates?.() ?? [];
      const templates = [...new Set([...all.map((a) => a.template), ...scopes.map((s) => s.name)])].sort().map((template) => {
        const mine = all.filter((a) => a.template === template);
        return { template, approvals: mine, radius: radiusOf(template, mine.map((a) => a.profile), scopes) };
      });
      const revoked = o.repo.revoked('approved_for', REVOKED_SHOWN).flatMap((t): RevokedApproval[] => {
        const a = approvalOf(t);
        return a ? [{ ...a, revokedBy: t.revokedBy!, revokedAt: t.revokedAt! }] : [];
      });
      const holders = o.holders?.() ?? { machines: [], jobs: [] };
      return { status, model: model(), templates, holders, revoked, decisions: o.repo.decisions(DECISIONS_SHOWN) };
    },
    start() {
      model();
      void sync();
      timer = setInterval(() => { void sync(); }, o.syncMs ?? ACCESS_SYNC_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

