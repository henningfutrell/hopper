// The logins (issue #476, design.md "Logins"): a login a job or run waits on, apart from the questions. A run
// reports it; it never opens a question and never reaches an escalation level. The hopper keeps the login
// (`logins`, the user's schema) and its events, but the URL and the code — credentials in flight — only in
// this process's memory, dropped when the login ends; only a UI session of the user reads them. The run polls
// `check` for what the user did (a new code, cancel), and the hopper expires a login at `expiresAt` itself. Only the
// requester knows whether a login worked (issue #1110): it reports the outcome (`outcome`), and a person may dismiss one.
import type { Clock, UserStore } from '../domain/ports.ts';
import {
  DEFAULT_LOGIN_SETTINGS, jobPriorityTag, type EventType, type PriorityTag, type Login, type LoginBlocks, type LoginCheck, type LoginOutcome, type LoginReport, type LoginSettings, type LoginStatus, type LoginView, type RunLogins,
} from '../domain/types.ts';
import { LOGIN_KIND_HANDLERS } from './kinds.ts';
import type { LastAccounts } from './last-accounts.ts';
import { hideCodes } from './recognise.ts';

/** The host of a login's URL (issue #698): what asks, with no path or query, which may carry the code. */
const hostOf = (url: string): string => new URL(url).hostname;

/** Statuses a login is still open in: the user may still act on it. */
const OPEN: readonly LoginStatus[] = ['pending', 'expired'];

/** How long a reopened login waits for its requester's new code before it expires (issue #1110): a device code's usual life. */
export const REOPENED_SEC = 900;

export type LoginAction = { ok: true; login: Login } | { ok: false; reason: 'not_found' | 'ended' | 'not_renewable'; message: string };

export interface Logins {
  /**
   * A run reports a login it waits on. One open login per job (or question) and prompt: a report with the same
   * tool, code or URL is that login (issue #567) — the same code again changes nothing, a new code or expiry
   * updates it —, never a duplicate. Throws on a report its kind refuses.
   */
  report(report: LoginReport, blocks: LoginBlocks, restore?: boolean): Login;
  /** What the run waiting on login `id` does next; a new-code request or a cancel is answered once, then `ended` once it is. */
  check(id: string): LoginCheck;
  /** The login went through: a login signal, or a print-mode run that succeeded (issue #567). */
  completed(id: string): void;
  /** Its run said the code expired: expired now, as the sweep expires it at `expiresAt`. */
  expired(id: string): void;
  /** What waited on it ended first, or could not take it. */
  failed(id: string, reason: string): void;
  /** The user cancelled it. */
  cancel(id: string): LoginAction;
  /**
   * Its requester says what came of it (issue #1110): `completed` ends it, or completes one that ended otherwise;
   * `failed` fails an open one, or reopens a completed or dismissed one with the reason. Whatever its job does now.
   */
  outcome(id: string, outcome: LoginOutcome): LoginAction;
  /** A person put an open login away (issue #1110): dismissed, whatever its job does; its run is told it ended. */
  dismiss(id: string): LoginAction;
  /** The user asked for a new code: the run asks its tool again. */
  newCode(id: string): LoginAction;
  /**
   * Fail the open logins nothing waits on any more — whose job is no longer running, or whose question is no longer
   * open, an expired one too (issue #529) —, and expire the pending ones past `expiresAt`. Run on each tick.
   */
  sweep(): void;
  list(filter?: { status?: LoginStatus[]; limit?: number }): Login[];
  get(id: string): Login | undefined;
  /** The login as a route answers it; `secrets`: with its URL and code (a UI session of the user only). */
  view(login: Login, secrets: boolean): LoginView;
  settings(): LoginSettings;
  /** The logins as one run reports to them: each login names what waits on it. Nothing is written once `live` says no (shutdown). */
  forRun(blocks: Omit<LoginBlocks, 'renewable'>, live: () => boolean): RunLogins;
}

export interface LoginsOptions {
  store: UserStore;
  clock: Clock;
  /** The last accounts (issue #1269): recorded at each sweep, and shown on the logins of their tool and machine. */
  lastAccounts?: LastAccounts;
}

export function createLogins(o: LoginsOptions): Logins {
  const { store, clock } = o;
  /** The URL and code of each open login, and the account and scopes the tool showed (issue #698): never written anywhere. */
  const secrets = new Map<string, { verificationUrl: string; userCode?: string; account?: string; scopes?: string[] }>();
  /** What the user asked of a login, until its run reads it. */
  const asked = new Map<string, LoginCheck>();
  const now = (): string => clock.now().toISOString();
  const settings = (): LoginSettings => ({
    onExpiry: store.settings.getLoginExpiry() ?? DEFAULT_LOGIN_SETTINGS.onExpiry,
    warnSec: store.settings.getLoginWarnSec() ?? DEFAULT_LOGIN_SETTINGS.warnSec,
  });

  /** The live priority of what waits on the login (issue #535): its job, or the job of the question it runs for. */
  const tagOf = (l: Login): PriorityTag | undefined =>
    jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), l.jobId ?? (l.questionId ? store.questions.get(l.questionId)?.jobId : undefined));

  const emit = (type: EventType, l: Login, data: Record<string, unknown>): void => {
    store.events.append({
      type, ...(l.jobId ? { jobId: l.jobId } : {}), ...(l.laneId ? { laneId: l.laneId } : {}), ...(l.machineId ? { machineId: l.machineId } : {}),
      data: { loginId: l.id, kind: l.kind, tool: l.tool, ...data },
    });
  };

  /** End an open login: its status, the event, and its URL and code dropped. */
  const end = (l: Login, status: Exclude<LoginStatus, 'pending' | 'expired'>, data: Record<string, unknown>, patch: Partial<Login> = {}): Login => {
    secrets.delete(l.id);
    const type: EventType = status === 'completed' ? 'auth.completed' : status === 'cancelled' ? 'auth.cancelled' : status === 'dismissed' ? 'auth.dismissed' : 'auth.failed';
    return store.tx(() => {
      const next = store.logins.update(l.id, { status, endedAt: now(), newCodeAskedAt: undefined, ...patch });
      emit(type, next, data);
      return next;
    });
  };

  /** Two reports of one prompt: the same code, or, with no code, the same URL. */
  const samePrompt = (a: { verificationUrl: string; userCode?: string } | undefined, b: { verificationUrl: string; userCode?: string }): boolean =>
    a !== undefined && (a.userCode !== undefined || b.userCode !== undefined ? a.userCode === b.userCode : a.verificationUrl === b.verificationUrl);

  /**
   * Expire a pending login: its code dropped, `auth.expired`; the job fails on it while `onExpiry` says so, or, under
   * `renew` (issue #1016), a run that can ask its tool again is asked for a new code, which the same login takes.
   */
  const expire = (l: Login): void => {
    secrets.delete(l.id);
    // Read at each expiry (issue #356): a changed setting applies to the next one.
    const onExpiry = settings().onExpiry;
    const renewing = onExpiry === 'renew' && l.renewable;
    store.tx(() => {
      const next = store.logins.update(l.id, { status: 'expired', newCodeAskedAt: renewing ? now() : undefined });
      emit('auth.expired', next, { expiresAt: next.expiresAt, ...(renewing ? { renewing: true } : {}) });
    });
    if (onExpiry === 'fail') asked.set(l.id, { act: 'fail', reason: `the ${l.tool} login expired at ${l.expiresAt} before it was completed` });
    else if (renewing) asked.set(l.id, { act: 'new-code', expired: true });
  };

  const openOf = (id: string): Login | undefined => {
    const l = store.logins.get(id);
    return l && OPEN.includes(l.status) ? l : undefined;
  };

  const action = (id: string, act: (l: Login) => LoginAction): LoginAction => {
    const l = store.logins.get(id);
    if (!l) return { ok: false, reason: 'not_found', message: `login ${id} not found` };
    if (!OPEN.includes(l.status)) return { ok: false, reason: 'ended', message: `login ${id} is ${l.status}` };
    if (l.jobId && store.jobs.get(l.jobId)?.status !== 'running') return { ok: false, reason: 'ended', message: `the job waiting on login ${id} is no longer running` };
    return act(l);
  };

  const logins: Logins = {
    report(r, blocks, restore = false) {
      const problem = LOGIN_KIND_HANDLERS[r.kind].problem(r);
      if (problem) throw new Error(problem);
      const secret = {
        verificationUrl: r.verificationUrl, ...(r.userCode ? { userCode: r.userCode } : {}), ...(r.account ? { account: r.account } : {}), ...(r.scopes?.length ? { scopes: r.scopes } : {}),
      };
      const host = hostOf(r.verificationUrl);
      // The same prompt (issue #567): a script that polls, or a job that reports it again, under the same tool, or
      // another name for it with the same code or URL. Only this process holds the codes: after a restart, the tool.
      const same = store.logins.list({ status: [...OPEN], ...(blocks.jobId ? { jobId: blocks.jobId } : { questionId: blocks.questionId ?? '' }) })
        .find((l) => l.kind === r.kind && (l.tool === r.tool || samePrompt(secrets.get(l.id), secret)));
      const fields = { expiresAt: r.expiresAt, ...(r.intervalSec ? { intervalSec: r.intervalSec } : {}) };
      if (same) {
        const before = secrets.get(same.id);
        if (restore) {
          // Read again after a restart (its code went with the process): the URL and code come back, nothing else changes.
          if (same.status === 'pending' && before === undefined) secrets.set(same.id, secret);
          return same;
        }
        // The same code again (issue #567): nothing new happened. Its life began when it was first shown, so a later
        // report's expiry, counted from that report, moves nothing; and an expired code is not opened again.
        if (before !== undefined && before.userCode === secret.userCode && before.verificationUrl === secret.verificationUrl) return same;
        secrets.set(same.id, secret);
        return store.tx(() => {
          const next = store.logins.update(same.id, { ...blocks, ...fields, status: 'pending', newCodeAskedAt: undefined, reason: undefined });
          emit('auth.pending', next, { host, expiresAt: next.expiresAt, ...(next.intervalSec ? { intervalSec: next.intervalSec } : {}), run: next.run, ...(next.questionId ? { questionId: next.questionId } : {}), renewed: true, ...tagOf(next) });
          return next;
        });
      }
      if (restore) throw new Error('no open login to restore');
      return store.tx(() => {
        const l = store.logins.create({ ...blocks, kind: r.kind, tool: r.tool, ...fields });
        secrets.set(l.id, secret);
        emit('auth.pending', l, { host, expiresAt: l.expiresAt, ...(l.intervalSec ? { intervalSec: l.intervalSec } : {}), run: l.run, ...(l.questionId ? { questionId: l.questionId } : {}), ...tagOf(l) });
        return l;
      });
    },

    check(id) {
      const told = asked.get(id);
      if (told) { asked.delete(id); return told; }
      const l = store.logins.get(id);
      return l && !OPEN.includes(l.status) ? { act: 'ended' } : { act: 'wait' };
    },

    completed(id) {
      const l = openOf(id);
      if (l) end(l, 'completed', {});
    },

    expired(id) {
      const l = store.logins.get(id);
      if (l?.status === 'pending') expire(l);
    },

    failed(id, reason) {
      const l = openOf(id);
      if (l) end(l, 'failed', { reason }, { reason });
    },

    cancel(id) {
      return action(id, (l) => {
        asked.set(id, { act: 'cancelled' });
        return { ok: true, login: end(l, 'cancelled', { by: 'user' }) };
      });
    },

    outcome(id, o) {
      const l = store.logins.get(id);
      if (!l) return { ok: false, reason: 'not_found', message: `login ${id} not found` };
      if (o.outcome === 'completed') {
        return { ok: true, login: l.status === 'completed' ? l : end(l, 'completed', { by: 'requester' }, { reason: undefined }) };
      }
      // The requester's words: a code in them is hidden, as in any run's output.
      const code = secrets.get(id)?.userCode;
      const reason = hideCodes(o.reason, o.reason, code ? [code] : []);
      if (OPEN.includes(l.status)) return { ok: true, login: end(l, 'failed', { reason, by: 'requester' }, { reason }) };
      // Failed or cancelled already: nothing to reopen, as the user did not end it as done.
      if (l.status !== 'completed' && l.status !== 'dismissed') return { ok: true, login: l };
      // A completed login that does not work after all (issue #1110): open again, with why, until the requester reports a new code.
      return {
        ok: true, login: store.tx(() => {
          const next = store.logins.update(id, {
            status: 'pending', reason, endedAt: undefined, newCodeAskedAt: undefined, expiresAt: new Date(clock.now().getTime() + REOPENED_SEC * 1000).toISOString(),
          });
          emit('auth.reopened', next, { reason });
          return next;
        }),
      };
    },

    dismiss(id) {
      const l = store.logins.get(id);
      if (!l) return { ok: false, reason: 'not_found', message: `login ${id} not found` };
      if (!OPEN.includes(l.status)) return { ok: false, reason: 'ended', message: `login ${id} is ${l.status}` };
      asked.delete(id);
      return { ok: true, login: end(l, 'dismissed', { by: 'user' }) };
    },

    newCode(id) {
      return action(id, (l) => {
        if (!l.renewable) return { ok: false, reason: 'not_renewable', message: `the ${l.run} run waiting on login ${id} cannot ask ${l.tool} for a new code; cancel it, or run the job again` };
        asked.set(id, { act: 'new-code' });
        return { ok: true, login: store.logins.update(id, { newCodeAskedAt: now() }) };
      });
    },

    sweep() {
      o.lastAccounts?.record();
      const at = clock.now().getTime();
      for (const l of store.logins.list({ status: [...OPEN] })) {
        const job = l.jobId ? store.jobs.get(l.jobId) : undefined;
        if (l.jobId && job?.status !== 'running') {
          const reason = `the job ended${job?.error ? `: ${job.error}` : ''}`;
          end(l, 'failed', { reason }, { reason });
          continue;
        }
        if (!l.jobId && l.questionId && store.questions.get(l.questionId)?.status !== 'open') {
          const reason = 'the question ended';
          end(l, 'failed', { reason }, { reason });
          continue;
        }
        if (l.status !== 'pending' || Date.parse(l.expiresAt) > at) continue;
        expire(l);
      }
    },

    list: (filter) => store.logins.list(filter),
    get: (id) => store.logins.get(id),

    view(login, withSecrets) {
      const secret = OPEN.includes(login.status) ? secrets.get(login.id) : undefined;
      const lastAccount = o.lastAccounts?.of(login);
      const { hostOwner: _host, ...kept } = login; // the host that runs it names a machine: never answered
      return {
        ...kept, ...tagOf(login), codeKept: secret !== undefined, ...(secret ? { host: hostOf(secret.verificationUrl) } : {}), ...(withSecrets && secret ? secret : {}),
        ...(lastAccount !== undefined ? { lastAccount } : {}),
      };
    },

    settings,

    forRun: (blocks, live) => ({
      report: (r, x) => logins.report(r, { ...blocks, renewable: x.renewable }, x.restore === true).id,
      check: (id) => logins.check(id),
      completed: (id) => { if (live()) logins.completed(id); },
      expired: (id) => { if (live()) logins.expired(id); },
      failed: (id, reason) => { if (live()) logins.failed(id, reason); },
    }),
  };
  return logins;
}
