// Access (issue #559, design.md "Access: OpenFGA decides each mint"): the decision point the vault (issue #558) asks
// before every credential it mints or renews — `decideMint` —, the approvals and the model the hopper keeps and pushes
// to OpenFGA with the tuples of who is live (issue #581), and Users & access → Access's view. Fail closed: with no OpenFGA set
// up, OpenFGA not reached, a change it has not taken yet, a model it refused or that lacks a relation the hopper writes,
// or a requester that is not live, the answer is a deny, recorded like any other. Each template shows with its blast
// radius (issue #584), rated from its approvals and the vault templates of that name.
import { randomUUID } from 'node:crypto';
import { isRefusal, type AccessRepository, type AuthorizationServer, type Clock, type RelationshipTuple, type StoredTuple } from '../domain/ports.ts';
import type { AccessAnswer, JobStatus, LiveRequesters } from '../domain/types.ts';
import type { TrustLevel } from '../domain/trust-stamp.ts';
import { templateRadius, type TemplateScope } from '../blast-radius/template.ts';
import type { Access, LiveShare } from './access-port.ts';
import {
  profileProblem, type RadiusRules,
  type AccessDecisionRecord, type AccessModelView, type AccessStatus, type Approval, type MintDecision, type MintRequest, type RevokedApproval, type Asset, type OperationProfile,
} from '../domain/types.ts';
import { apiTokenBoxGaps, apiTokenGaps, artifactGaps, bastionGaps, compileAccessModel, DEFAULT_ACCESS_MODEL, gitlabIntakeGaps, intakeGaps, itemGaps, modelGaps, machineTerminalGaps, observeGaps, observeKept, searchHitGaps, sharedSecretGaps, systemSecretGaps, terminalGaps, trustGaps, vaultGrantGaps, type ModelJson } from './model.ts';
import { belowMinimum, gateTuples, holderTuples, minTrusts, setMinTrust, trustedPath, trustTuples } from './trust.ts';
import { apiTokenBoxCheck, apiTokenCheck, approvalTuples, artifactObject, gitlabIntakeActorCheck, intakeActorCheck, itemObject, linkObject, machineTerminalCheck, profileOf, relayCheck, requesterObject, searchHitCheck, requesterTuples, runningTuple, assetObject, sharedSecretCheck, shareTuples, systemSecretCheck, terminalCheck, userObject, vaultGrantObject, keyedByEmail } from './objects.ts';
import { requesterCopy, requesterRows, requesterText, standing, templateOnPath } from './requesters.ts';
import { AccessEditError, requestProblem } from './edits.ts';

/** A job is live while it is claimed, running, waiting on an answer or on its own wait (issue #483): parked, operator-led, ended or not yet started, it gets nothing. */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = ['claimed', 'running', 'waiting_answer', 'waiting_on'];
/** How often everything is pushed again: drift in OpenFGA is put back, and an OpenFGA come back is found. */
export const ACCESS_SYNC_MS = 30_000;
/** How often who is live is compared with what OpenFGA was given: a job started or ended, a box joined or left (issue #581). */
export const REQUESTERS_CHECK_MS = 2_000;
const STORE_NAME = 'hopper', DECISIONS_SHOWN = 50, REVOKED_SHOWN = 20;
export const NOT_CONFIGURED = 'OpenFGA is not set up: set HOPPER_OPENFGA_URL (docs/deploy.md "Access: OpenFGA")';

export { AccessEditError, requestProblem } from './edits.ts';

export type { Access, ArtifactViewer, LiveShare } from './access-port.ts';

export interface AccessOptions {
  repo: AccessRepository;
  /** OpenFGA, or undefined while none is set up. */
  server: AuthorizationServer | undefined;
  clock: Clock;
  /** A job's status, or undefined when the user has no such job: what a deny for a job not live says. */
  jobStatus(userId: string, jobId: string): string | undefined;
  /** Who is live now, per user (issue #581): written to OpenFGA, and what a requester may ask by. */
  requesters(): LiveRequesters[];
  logger: { warn(line: string): void };
  syncMs?: number;
  /** Every user's vault templates (issue #584), each with that user's blast-radius rules: what a template's rating reads beside its approvals. */
  templates?: () => { name: string; scope: TemplateScope; rules: RadiusRules }[];
  /** Every user's live artifact shares (issue #624): written to OpenFGA as viewers. */
  shares?: () => LiveShare[];
  /** The verified email each user is known by, by user id (issue #1380): OpenFGA names a person by it. */
  emails?: () => ReadonlyMap<string, string>;
}

const KEY_STORE = 'storeId', KEY_PUSHED = 'pushedModel', SYSTEM = 'hopper';

const tupleKey = (t: RelationshipTuple) => `${t.subject} ${t.relation} ${t.object}`;
const plain = (t: StoredTuple): RelationshipTuple => ({ subject: t.subject, relation: t.relation, object: t.object });
const describeAsset = (t: Asset) => `${t.kind} ${t.name}`;
const keyOf = (ts: RelationshipTuple[]): string => ts.map(tupleKey).sort().join('\n');
const gapsOf = (dsl: string): string[] => modelGaps(compileAccessModel(dsl));


export function createAccess(o: AccessOptions): Access {
  const now = () => o.clock.now().toISOString();
  let status: AccessStatus = o.server ? { state: 'unreachable', why: 'not asked yet' } : { state: 'not-configured', why: NOT_CONFIGURED };
  // Something in the database OpenFGA may not hold yet: nothing is asked of OpenFGA until it is pushed.
  let dirty = true;
  let running: Promise<void> | undefined;
  // Stopped: nothing more is pushed, so nothing touches the store the daemon closes next.
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let watch: NodeJS.Timeout | undefined;
  // Who is live, as last pushed: a check asks OpenFGA only once it holds who is live now.
  let pushedRequesters: string | undefined;
  // What the model lacks for artifacts, for system secrets (issue #657) and for items (issue #662), by its text: asked every 2 s, compiled once per model.
  const gapsMemo = (gapsIn: (m: ModelJson) => string[]): ((dsl: string) => string[]) => {
    let memo: { dsl: string; gaps: string[] } | undefined;
    return (dsl) => (memo?.dsl === dsl ? memo : (memo = { dsl, gaps: gapsIn(compileAccessModel(dsl)) })).gaps;
  };
  const artifactGapsOf = gapsMemo(artifactGaps), systemGapsOf = gapsMemo(systemSecretGaps), itemGapsOf = gapsMemo(itemGaps), vaultGrantGapsOf = gapsMemo(vaultGrantGaps), sharedGapsOf = gapsMemo(sharedSecretGaps), apiTokenGapsOf = gapsMemo(apiTokenGaps), intakeGapsOf = gapsMemo(intakeGaps), gitlabIntakeGapsOf = gapsMemo(gitlabIntakeGaps), boxGapsOf = gapsMemo(apiTokenBoxGaps), searchGapsOf = gapsMemo(searchHitGaps), terminalGapsOf = gapsMemo(terminalGaps), machineTerminalGapsOf = gapsMemo(machineTerminalGaps), trustGapsOf = gapsMemo(trustGaps), observeGapsOf = gapsMemo(observeGaps), bastionGapsOf = gapsMemo(bastionGaps);

  const model = (): AccessModelView => {
    const m = o.repo.model() ?? o.repo.addModel(DEFAULT_ACCESS_MODEL, SYSTEM, now());
    return { version: m.seq, dsl: m.dsl, writtenBy: m.writtenBy, writtenAt: m.writtenAt };
  };
  /** A model the hopper wrote and nobody edited, without a relation this build writes: the default of this build, a new version. */
  const upgradeModel = (): void => {
    const m = o.repo.model();
    if (!m || m.writtenBy !== SYSTEM || m.dsl === DEFAULT_ACCESS_MODEL || gapsOf(m.dsl).length + artifactGapsOf(m.dsl).length + systemGapsOf(m.dsl).length + itemGapsOf(m.dsl).length + sharedGapsOf(m.dsl).length + apiTokenGapsOf(m.dsl).length + boxGapsOf(m.dsl).length + intakeGapsOf(m.dsl).length + gitlabIntakeGapsOf(m.dsl).length + vaultGrantGapsOf(m.dsl).length + searchGapsOf(m.dsl).length + terminalGapsOf(m.dsl).length + machineTerminalGapsOf(m.dsl).length + trustGapsOf(m.dsl).length + observeGapsOf(m.dsl).length + bastionGapsOf(m.dsl).length === 0) return;
    o.repo.addModel(DEFAULT_ACCESS_MODEL, SYSTEM, now());
    o.logger.warn('hopper: access: the access model the hopper wrote lacked the requester relations (issue #581): the default model is saved as a new version');
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

  /** The live shares as tuples, when the model has what they need; else none (a share is then denied, never a mint). */
  const liveShareTuples = (): RelationshipTuple[] => (o.shares && artifactGapsOf(model().dsl).length === 0 ? shareTuples(o.shares()) : []);
  /** Each live job's trust and each profile's gate (issue #655, part 15), when the model has what they need; else none. */
  const liveTrustTuples = (): RelationshipTuple[] => (trustGapsOf(model().dsl).length === 0 ? [...trustTuples(o.requesters()), ...gateTuples(o.repo.liveTuples())] : []);
  /** The approvals as kept, but each grant of observe (issue #2146) while the model lacks it: OpenFGA would refuse it, and every mint with it. */
  const liveApprovalTuples = (): RelationshipTuple[] => observeKept(o.repo.liveTuples().map(plain), observeGapsOf(model().dsl));
  /** Tuples as OpenFGA is given them: a person by their email (issue #1380). Asked once per use, so a user who takes an email is moved at the next. */
  const emailKeyed = (): ((t: RelationshipTuple) => RelationshipTuple) => keyedByEmail(o.emails?.() ?? new Map());
  /** Who is live and what is shared, as written: a check asks OpenFGA only once it holds both as they are now. */
  const liveKey = (): string => keyOf([...requesterTuples(o.requesters()), ...liveShareTuples(), ...liveTrustTuples()].map(emailKeyed()));

  const push = async (server: AuthorizationServer): Promise<void> => {
    const storeId = await server.store(o.repo.state(KEY_STORE), STORE_NAME);
    if (storeId !== o.repo.state(KEY_STORE)) o.repo.setState(KEY_STORE, storeId);
    const m = model();
    const gaps = gapsOf(m.dsl);
    if (gaps.length > 0) throw new Error(`the access model lacks what the hopper writes or asks: ${gaps.join(', ')}: save one that has them in Users & access → Access`);
    let pushed = pushedModel();
    if (pushed?.storeId !== storeId || pushed.version !== m.version) {
      const modelId = await server.writeModel(storeId, compileAccessModel(m.dsl));
      pushed = { storeId, version: m.version, modelId };
      o.repo.setState(KEY_PUSHED, JSON.stringify(pushed));
    }
    const key = emailKeyed(), who = [...requesterTuples(o.requesters()), ...liveShareTuples(), ...liveTrustTuples()].map(key);
    const want = new Map([...liveApprovalTuples().map(key), ...who].map((t) => [tupleKey(t), t]));
    const have = new Map((await server.tuples(storeId)).map((t) => [tupleKey(t), t]));
    const writes = [...want].filter(([k]) => !have.has(k)).map(([, t]) => t);
    const deletes = [...have].filter(([k]) => !want.has(k)).map(([, t]) => t);
    if (writes.length + deletes.length > 0) await server.write(storeId, pushed.modelId, { writes, deletes });
    pushedRequesters = keyOf(who);
    status = { state: 'connected', syncedAt: now(), storeId, modelId: pushed.modelId };
  };

  const sync = (): Promise<void> => {
    const server = o.server;
    if (!server || stopped) return Promise.resolve();
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

  /** OpenFGA's answer for `subject`, once everything is pushed; a deny when it cannot be had. `template`: the one it runs as, for the reason. */
  const ask = async (subject: string, contextual: RelationshipTuple[], r: Omit<MintRequest, 'requester'>, who: string):
  Promise<Pick<MintDecision, 'allowed' | 'reason' | 'path' | 'modelId'>> => {
    const server = o.server;
    if (!server) return { allowed: false, reason: NOT_CONFIGURED };
    if (liveKey() !== pushedRequesters) dirty = true;
    if (dirty) { await running; await sync(); }
    if (dirty) return { allowed: false, reason: `OpenFGA cannot be asked: ${status.why ?? 'unknown'}` };
    const pushed = pushedModel()!, noObserve = r.operation === 'observe' ? observeGapsOf(model().dsl) : [];
    const profile = { operation: r.operation, asset: r.asset }, key = emailKeyed(); if (noObserve.length > 0) return { allowed: false, modelId: pushed.modelId, reason: `the access model lacks what observe needs: ${noObserve.join(', ')}: add it in Users & access → Access` };
    try {
      const allowed = await server.check(pushed.storeId, pushed.modelId, key({ subject, relation: `can_${r.operation}`, object: assetObject(r.asset) }), contextual.map(key));
      if (!allowed) return { allowed, modelId: pushed.modelId, reason: `${who} is not approved to ${r.operation} on ${describeAsset(r.asset)}` };
      const path = trustedPath([...liveApprovalTuples(), ...requesterTuples(o.requesters()), ...liveTrustTuples(), ...contextual], subject, profile)?.map(key);
      const through = templateOnPath(path);
      return { allowed, modelId: pushed.modelId, reason: `${through === undefined ? who : `template ${through}`} is approved to ${r.operation} on ${describeAsset(r.asset)}`, ...(path ? { path } : {}) };
    } catch (e) {
      dirty = true;
      down((e as Error).message);
      return { allowed: false, reason: `OpenFGA cannot be asked: ${(e as Error).message}` };
    }
  };

  /**
   * OpenFGA's answer for a made-up live job of the template (`job:<kind>/<uuid>`, `running` it, told for this check only): a trial, or a read-only
   * check's mint (issue #797). Its trust (issue #655, part 15) is told too: the level a trial names, else owner, as it is no job from intake.
   */
  const askAsTemplate = (kind: 'trial' | 'check', r: Omit<MintRequest, 'requester'> & { template: string; level?: TrustLevel }, job = `job:${kind}/${randomUUID()}`) =>
    ask(job, [runningTuple(job, r.template), ...(trustGapsOf(model().dsl).length === 0 ? holderTuples(job, r.level ?? 'owner') : [])], r, `template ${r.template}`);

  const approvalOf = (approval: StoredTuple): Approval | undefined => {
    const id = approval.object.replace(/^operation_profile:/, '');
    const profile = profileOf(id);
    if (!profile || !approval.subject.startsWith('template:')) return undefined;
    const template = approval.subject.slice('template:'.length);
    const { grant } = approvalTuples(template, profile);
    return { id: approval.seq, template, profile, approvedBy: approval.writtenBy, approvedAt: approval.writtenAt, chain: [plain(approval), grant] };
  };

  const approvals = (): Approval[] => o.repo.liveTuples().filter((t) => t.relation === 'approved_for').map(approvalOf).filter((a): a is Approval => a !== undefined);

  /** OpenFGA's answer to one check apart from mints (an artifact, a system secret), once everything is pushed; a deny when it cannot be had, marked `unavailable` (issue #696). Not recorded. */
  const checkOnce = async (what: string, gaps: string[], tuple: RelationshipTuple, contextual: RelationshipTuple[], why: (allowed: boolean) => string): Promise<AccessAnswer> => {
    const server = o.server;
    if (!server) return { allowed: false, reason: NOT_CONFIGURED, unavailable: true };
    if (gaps.length > 0) return { allowed: false, reason: `the access model lacks what ${what} need: ${gaps.join(', ')}: add it in Users & access → Access` };
    if (liveKey() !== pushedRequesters) dirty = true;
    if (dirty) { await running; await sync(); }
    if (dirty) return { allowed: false, reason: `OpenFGA cannot be asked: ${status.why ?? 'unknown'}`, unavailable: true };
    const pushed = pushedModel()!, key = emailKeyed();
    try {
      const allowed = await server.check(pushed.storeId, pushed.modelId, key(tuple), contextual.map(key));
      return { allowed, reason: why(allowed) };
    } catch (e) {
      dirty = true;
      down((e as Error).message);
      return { allowed: false, reason: `OpenFGA cannot be asked: ${(e as Error).message}`, unavailable: true };
    }
  };

  /** One check whose reason reads `<subject> may (not) <doing>`, against what the model lacks for it. */
  const may = (what: string, gapsOf: (dsl: string) => string[], c: { tuple: RelationshipTuple; contextual: RelationshipTuple[] }, doing: (t: RelationshipTuple) => string): Promise<AccessAnswer> =>
    checkOnce(what, gapsOf(model().dsl), c.tuple, c.contextual, (allowed) => `${emailKeyed()(c.tuple).subject} may${allowed ? '' : ' not'} ${doing(c.tuple)}`);

  return {
    decideView: (viewer, artifact) => checkOnce('artifacts', artifactGapsOf(model().dsl), {
      subject: viewer.kind === 'user' ? userObject(viewer.userId) : linkObject({ userId: viewer.userId, shareId: viewer.shareId }), relation: 'can_view', object: artifactObject(artifact),
    }, [], (allowed) => (allowed ? 'it is shared with them' : 'it is not shared with them, or the share was revoked or expired')),
    decideSystemSecret: (ask) => may('system secrets', systemGapsOf, systemSecretCheck(ask), (t) => `${ask.action} ${t.object}`),
    decideSharedSecret: (ask) => may('shared secrets', sharedGapsOf, sharedSecretCheck(ask), (t) => `${ask.action} ${t.object}`),
    decideApiToken: (ask) => may('API tokens', apiTokenGapsOf, apiTokenCheck(ask), (t) => `use the token for ${t.relation}`),
    decideBoxAction: (ask) => may('box actions', boxGapsOf, apiTokenBoxCheck(ask), (t) => `use the token for ${t.relation}`),
    // Search hits (issue #945): a private one (a direct job's) only its owner sees.
    decideSearchHit: (viewerId, hit) => may('search hits', searchGapsOf, searchHitCheck(viewerId, hit), () => (hit.private ? 'see a private hit: only its owner does' : 'see the hit')), decideTextAcceptance(userId, item) {
      const object = itemObject(item);
      return checkOnce('accepting new text', itemGapsOf(model().dsl), { subject: userObject(userId), relation: 'can_accept_text', object },
        [{ subject: userObject(item.ownerId), relation: 'owner', object }], (allowed) => (allowed ? 'they own the item' : 'only the item\'s owner may accept its new text'));
    },
    decideVaultGrant: (userId, grant) => checkOnce('vault grants', vaultGrantGapsOf(model().dsl), { subject: userObject(userId), relation: 'can_grant', object: vaultGrantObject(grant) },
      [{ subject: userObject(grant.ownerId), relation: 'owner', object: vaultGrantObject(grant) }], (allowed) => (allowed ? 'they own the job' : 'only the job\'s owner may grant it the vault')),
    decideTerminal: (userId, terminal) => may('a job\'s terminal', terminalGapsOf, terminalCheck(userId, terminal), () => 'attach to the job\'s terminal'),
    decideMachineTerminal: (userId, terminal) => may('a machine\'s terminal', machineTerminalGapsOf, machineTerminalCheck(userId, terminal), () => 'attach to the machine\'s terminal'), decideRelay: (ask) => may('relay connections', bastionGapsOf, relayCheck(ask), () => `relay to ${ask.target}`),
    decideIntakeActor: (userId, login, actors) => { const c = intakeActorCheck(userId, login, actors); return checkOnce('intake', intakeGapsOf(model().dsl), c.tuple, c.contextual, (allowed) => `${login} is${allowed ? '' : ' not'} a trusted actor`); },
    // On GitLab (issue #1448): a GitLab user by its GitLab and id, the user's GitLab account told as the trusted actor.
    decideGitLabIntakeActor: (userId, actor, actors) => { const c = gitlabIntakeActorCheck(userId, actor, actors); return checkOnce('intake on GitLab', gitlabIntakeGapsOf(model().dsl), c.tuple, c.contextual, (allowed) => `GitLab user ${actor.userId} is${allowed ? '' : ' not'} a trusted actor`); },
    approvedProfiles: () => approvals().reduce((by, a) => by.set(a.template, [...by.get(a.template) ?? [], a.profile]), new Map<string, OperationProfile[]>()),
    async revokeProfile(template, profile, by) {
      const { approval } = approvalTuples(template, profile);
      const live = o.repo.liveTuples().find((t) => t.relation === 'approved_for' && t.subject === approval.subject && t.object === approval.object);
      if (!live || !o.repo.revokeTuple(live.seq, by, now())) return;
      await changed();
    },
    async decideMint(request) {
      const { requester, operation, asset } = request;
      const base = { requester: requesterCopy(requester), operation, asset };
      const problem = profileProblem(request);
      if (problem) return record({ ...base, allowed: false, reason: `not a request the model can hold: ${problem}` });
      const asks = standing(o.requesters(), requester, o.jobStatus);
      if ('problem' in asks) return record({ ...base, allowed: false, reason: asks.problem });
      const at = asks.template === undefined ? {} : { template: asks.template };
      const answer = await ask(requesterObject(requester), [], request, requesterText(requester, asks.template, o.emails?.().get(requester.userId)));
      // Denied by OpenFGA for a job below the profile's minimum trust (issue #655, part 15): the reason says so.
      const below = answer.allowed || answer.modelId === undefined ? undefined : belowMinimum(o.requesters(), o.repo.liveTuples(), requester, request, `${operation} on ${describeAsset(asset)}`);
      return record({ ...base, ...at, ...answer, ...(below ? { reason: below } : {}) });
    },
    async decideCheckMint({ check, template, operation, asset }) {
      const problem = requestProblem({ template, operation, asset });
      return record({ check: { box: check }, template, operation, asset, ...(problem ? { allowed: false, reason: `not a request the model can hold: ${problem}` } : await askAsTemplate('check', { template, operation, asset })) });
    },
    async tryCheck(request, by) {
      const problem = requestProblem(request);
      if (problem) throw new AccessEditError(400, problem);
      const { template, operation, asset, level } = request;
      return record({ trial: { by, ...(level ? { level } : {}) }, template, operation, asset, ...await askAsTemplate('trial', request) });
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
    minTrusts: () => minTrusts(o.repo.liveTuples()),
    async setMinTrust(profile, level, by) {
      if (setMinTrust(o.repo, profile, level, { by, at: now(), gaps: trustGapsOf(model().dsl) })) await changed();
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
      const set = minTrusts(o.repo.liveTuples()).length, trust = trustGaps(json);
      if (set > 0 && trust.length > 0) throw new AccessEditError(400, `the model lacks what a minimum trust needs (${trust.join(', ')}), and ${set} operation profile(s) have one: clear them first`);
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
    status: () => status,
    view() {
      const live = o.requesters(), key = emailKeyed();
      const tuples = [...o.repo.liveTuples().map(plain), ...requesterTuples(live), ...liveTrustTuples()];
      const all = approvals();
      const scopes = o.templates?.() ?? [];
      const templates = [...new Set([...all.map((a) => a.template), ...scopes.map((s) => s.name)])].sort().map((template) => {
        const mine = all.filter((a) => a.template === template);
        return { template, approvals: mine, radius: templateRadius(template, mine.map((a) => a.profile), scopes) };
      });
      const revoked = o.repo.revoked('approved_for', REVOKED_SHOWN).flatMap((t): RevokedApproval[] => {
        const a = approvalOf(t);
        return a ? [{ ...a, revokedBy: t.revokedBy!, revokedAt: t.revokedAt! }] : [];
      });
      const requesters = requesterRows(live, tuples, all.map((a) => a.profile), key);
      return { status, model: model(), templates, revoked, requesters, decisions: o.repo.decisions(DECISIONS_SHOWN), minTrust: minTrusts(o.repo.liveTuples()) };
    },
    start() {
      upgradeModel();
      void sync();
      timer = setInterval(() => { void sync(); }, o.syncMs ?? ACCESS_SYNC_MS);
      timer.unref();
      // A job started or ended, a box joined or left: pushed at once, not at the next full push.
      watch = setInterval(() => {
        if (status.state === 'connected' && !running && liveKey() !== pushedRequesters) void changed();
      }, REQUESTERS_CHECK_MS);
      watch.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (watch) clearInterval(watch);
      timer = undefined;
      watch = undefined;
      await running;
    },
  };
}

