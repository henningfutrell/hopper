// Tool sign-ins (issue #1128, design.md "Tool sign-in"): a person signs a machine's agent tool in again from the hopper, with no
// terminal there. The usage source that reads the tool on that machine starts its sign-in (`UsageSource.signIn`); the sign-in is
// a login of kind `paste_code` on that machine, with no job: the person opens its URL, signs in, and pastes the code the page
// shows, which goes to the tool. The tool's end completes or fails the login. One sign-in per machine and tool (issue #2898): asked
// again while one waits, the answer is that one; one that cannot go on (expired or about to, another account, on another host) is
// superseded by the new one; a unique index in the database holds it across hosts. What runs on the machine is held in this process only: after a restart its login fails, and is started again.
// On two hosts on one database (issue #1627) the login names the host that runs it: another host leaves it alone while that
// host lives, and fails it once that host stopped.
// The hopper's Claude sign-in for pods (issue #1287, design.md "The hopper's Claude sign-in for pods") is one more: `claude
// setup-token` in the hopper itself, its login on no machine and naming the account; the token it printed is in the vault as
// soon as it is read (issue #1610), and the login completes once the run ends.
import type { Clock, UsageSource } from '../domain/ports.ts';
import type { Login, ToolSignIn } from '../domain/types.ts';
import { codeProblem, SIGN_IN_LIFE_MS } from '../client/sign-in.ts';
import type { LoginAction, Logins } from './service.ts';
import { SETUP_TOKEN_TOOL, type SetupTokenRun } from './setup-token.ts';

/** What a sign-in login names as its run. */
export const SIGN_IN_RUN = 'sign-in';

export type SignInStart = { ok: true; login: Login } | { ok: false; reason: 'not_found' | 'no_sign_in' | 'not_started'; message: string };
export type SignInPaste = LoginAction | { ok: false; reason: 'bad_code'; message: string };

export interface SignIns {
  /** Start the sign-in of usage source `source`'s tool on its machine; `email`: the account to pre-fill. */
  start(source: string, o?: { email?: string }): Promise<SignInStart>;
  /** Start the hopper's `claude setup-token` for the account `account` (an email), for `by`; its token is kept once it ends. */
  startSetupToken(o: { account: string; by: string }): Promise<SignInStart>;
  /** Give the sign-in of login `id` the code its page showed; answers the login once the tool ended: completed, or failed and why. */
  paste(id: string, code: string): Promise<SignInPaste>;
  /** Stop each sign-in whose login ended (cancelled, dismissed, expired); fail each open sign-in login nothing here runs. */
  sweep(): void;
  /** Stop every sign-in (shutdown). */
  stop(): void;
}

const OPEN = new Set(['pending', 'expired']);

/** A sign-in with less time than this to go is not worth a person's start: a new one supersedes it. */
const REUSE_MIN_LEFT_MS = 2 * 60_000;

/** A sign-in that runs: a tool's on a machine, or the hopper's setup token, on none; `account`: the account it was asked for. */
type Run = Omit<ToolSignIn, 'machineId'> & { machineId?: string; account?: string };

export function createSignIns(o: {
  logins: Logins; sources: () => readonly UsageSource[]; clock: Clock; sweepMs?: number;
  /** This host as a lease owner, and whether another host still runs (src/sagas/leases.ts). Absent: this host alone. */
  hosts?: { owner: string; live(owner: string): boolean };
  /** A sign-in completed: the tool on `machineId` is signed in now (the not-signed-in questions there are answered). */
  onSignedIn?: (s: { machineId: string; tool: string; loginId: string }) => void;
  /**
   * The hopper's Claude sign-in for pods (issue #1287): `start` runs `claude setup-token`, whose run keeps the token it prints
   * for `account` as soon as it reads it, and ends ok only when the token is kept. Absent: none starts.
   */
  setupToken?: { start(k: { account: string; by: string }): Promise<SetupTokenRun> };
}): SignIns {
  const { logins } = o;
  /** The sign-ins running now, by login id. */
  const runs = new Map<string, Run>();
  /** The sign-ins given their code, until the tool ends. */
  const pasting = new Set<string>();

  /** The sign-ins being started now, by machine and tool: two asks at one moment are one start. */
  const starting = new Map<string, Promise<SignInStart>>();
  const startOnce = (key: string, go: () => Promise<SignInStart>): Promise<SignInStart> => {
    const had = starting.get(key);
    if (had) return had;
    const start = go().finally(() => starting.delete(key));
    starting.set(key, start);
    return start;
  };

  /** The open sign-in logins of a machine and tool. */
  const openOn = (machineId: string | undefined, tool: string): Login[] =>
    logins.list({ status: ['pending', 'expired'] }).filter((l) => l.run === SIGN_IN_RUN && !l.jobId && !l.questionId && l.tool === tool && l.machineId === machineId);

  /** The sign-in that waits there and that this host can go on with, for `account` when it names one. */
  const reusable = (machineId: string | undefined, tool: string, account: string | undefined): Login | undefined => {
    const l = openOn(machineId, tool).find((x) => x.status === 'pending');
    if (!l) return undefined;
    if (pasting.has(l.id)) return l;
    const run = runs.get(l.id);
    if (!run || Date.parse(l.expiresAt) - o.clock.now().getTime() < REUSE_MIN_LEFT_MS) return undefined;
    return account === undefined || run.account === account ? l : undefined;
  };

  /** The login of a run that started: the one that waits if there is one (the run stopped), else a new one that supersedes the ones before. */
  const open = (run: Run, shownAccount?: string): SignInStart => {
    const waiting = reusable(run.machineId, run.tool, run.account);
    if (waiting) {
      run.cancel();
      return { ok: true, login: waiting };
    }
    const replaced = openOn(run.machineId, run.tool);
    const expiresAt = new Date(o.clock.now().getTime() + SIGN_IN_LIFE_MS).toISOString();
    let opened: { login: Login; opened: boolean };
    try {
      opened = logins.openSignIn({ kind: 'paste_code', tool: run.tool, verificationUrl: run.url, expiresAt, ...(shownAccount ? { account: shownAccount } : {}) }, { ...(run.machineId ? { machineId: run.machineId } : {}), run: SIGN_IN_RUN, renewable: false, ...(o.hosts ? { hostOwner: o.hosts.owner } : {}) }, replaced);
    } catch (e) {
      run.cancel();
      return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
    }
    for (const l of replaced) {
      runs.get(l.id)?.cancel();
      runs.delete(l.id);
    }
    if (opened.opened) runs.set(opened.login.id, run);
    else run.cancel();
    return { ok: true, login: opened.login };
  };

  const signIns: SignIns = {
    async start(name, x = {}) {
      const source = o.sources().find((s) => s.name === name);
      if (!source) return { ok: false, reason: 'not_found', message: `usage source ${name} not found` };
      if (!source.signIn) return { ok: false, reason: 'no_sign_in', message: `usage source ${name} cannot start its tool's sign-in` };
      const signIn = source.signIn.bind(source);
      let key = `source ${name}`;
      try {
        const target = await source.signInTarget?.();
        if (target) {
          const waiting = reusable(target.machineId, target.tool, x.email);
          if (waiting) return { ok: true, login: waiting };
          key = `${target.machineId} ${target.tool}`;
        }
      } catch (e) {
        return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
      return startOnce(key, async () => {
        let run: ToolSignIn;
        try {
          run = await signIn(x.email ? { email: x.email } : {});
        } catch (e) {
          return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
        }
        return open(x.email ? { ...run, account: x.email } : run);
      });
    },

    async startSetupToken({ account, by }) {
      const setup = o.setupToken;
      if (!setup) return { ok: false, reason: 'no_sign_in', message: 'this hopper cannot run claude setup-token' };
      const waiting = reusable(undefined, SETUP_TOKEN_TOOL, account);
      if (waiting) return { ok: true, login: waiting };
      return startOnce(` ${SETUP_TOKEN_TOOL}`, async () => {
        let started: SetupTokenRun;
        try {
          started = await setup.start({ account, by });
        } catch (e) {
          return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
        }
        return open({
          tool: SETUP_TOKEN_TOOL, url: started.url, account, cancel: () => started.cancel(),
          async paste(code) {
            const end = await started.paste(code);
            return end.ok ? { ok: true } : end;
          },
        }, account);
      });
    },

    async paste(id, code) {
      const login = logins.get(id);
      if (!login) return { ok: false, reason: 'not_found', message: `login ${id} not found` };
      const ended = (message: string): SignInPaste => ({ ok: false, reason: 'ended', message });
      if (login.kind !== 'paste_code' || login.run !== SIGN_IN_RUN) return ended('this login takes no code here');
      if (login.supersededBy) return ended('this sign-in was replaced; use the current card');
      if (pasting.has(id)) return ended('this sign-in has its code already: wait for its answer');
      if (!OPEN.has(login.status)) return ended(`this sign-in is ${login.status}: start it again`);
      const run = runs.get(id);
      if (!run) return ended('this hopper does not hold this sign-in (another host runs it, or it restarted): start it again');
      const problem = codeProblem(code);
      if (problem) return { ok: false, reason: 'bad_code', message: problem };
      runs.delete(id);
      pasting.add(id);
      try {
        const end = await run.paste(code.trim());
        if (end.ok) {
          logins.completed(id);
          if (run.machineId) o.onSignedIn?.({ machineId: run.machineId, tool: run.tool, loginId: id });
        } else logins.failed(id, end.reason);
      } finally {
        pasting.delete(id);
      }
      return { ok: true, login: logins.get(id)! };
    },

    sweep() {
      for (const [id, run] of runs) {
        const l = logins.get(id);
        if (l?.status === 'pending') continue;
        runs.delete(id);
        run.cancel();
        // Expired: the tool stops waiting at the same time. Start it again.
        if (l?.status === 'expired') logins.failed(id, 'no code came before the sign-in expired: start it again');
      }
      for (const l of logins.list({ status: ['pending', 'expired'] })) {
        if (l.run !== SIGN_IN_RUN || l.jobId || l.questionId || runs.has(l.id) || pasting.has(l.id)) continue;
        // Another host's that still runs is that host's to end.
        if (l.hostOwner && o.hosts && l.hostOwner !== o.hosts.owner && o.hosts.live(l.hostOwner)) continue;
        logins.failed(l.id, 'the hopper restarted while the sign-in waited: start it again');
      }
    },

    stop() {
      clearInterval(timer);
      for (const run of runs.values()) run.cancel();
      runs.clear();
    },
  };
  const timer = setInterval(() => signIns.sweep(), o.sweepMs ?? 5000);
  timer.unref();
  return signIns;
}
