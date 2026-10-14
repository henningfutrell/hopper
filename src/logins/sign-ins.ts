// Tool sign-ins (issue #1128, design.md "Tool sign-in"): a person signs a machine's agent tool in again from the hopper, with no
// terminal there. The usage source that reads the tool on that machine starts its sign-in (`UsageSource.signIn`); the sign-in is
// a login of kind `paste_code` on that machine, with no job: the person opens its URL, signs in, and pastes the code the page
// shows, which goes to the tool. The tool's end completes or fails the login. One sign-in per machine and tool: a new one cancels
// the one before. What runs on the machine is held in this process only: after a restart its login fails, and is started again.
import type { Clock, UsageSource } from '../domain/ports.ts';
import type { Login, ToolSignIn } from '../domain/types.ts';
import { codeProblem, SIGN_IN_LIFE_MS } from '../client/sign-in.ts';
import type { LoginAction, Logins } from './service.ts';

/** What a sign-in login names as its run. */
export const SIGN_IN_RUN = 'sign-in';

export type SignInStart = { ok: true; login: Login } | { ok: false; reason: 'not_found' | 'no_sign_in' | 'not_started'; message: string };
export type SignInPaste = LoginAction | { ok: false; reason: 'bad_code'; message: string };

export interface SignIns {
  /** Start the sign-in of usage source `source`'s tool on its machine; `email`: the account to pre-fill. */
  start(source: string, o?: { email?: string }): Promise<SignInStart>;
  /** Give the sign-in of login `id` the code its page showed; answers the login once the tool ended: completed, or failed and why. */
  paste(id: string, code: string): Promise<SignInPaste>;
  /** Stop each sign-in whose login ended (cancelled, dismissed, expired); fail each open sign-in login nothing here runs. */
  sweep(): void;
  /** Stop every sign-in (shutdown). */
  stop(): void;
}

const OPEN = new Set(['pending', 'expired']);

export function createSignIns(o: { logins: Logins; sources: () => readonly UsageSource[]; clock: Clock; sweepMs?: number }): SignIns {
  const { logins } = o;
  /** The sign-ins running now, by login id. */
  const runs = new Map<string, ToolSignIn>();
  /** The sign-ins given their code, until the tool ends. */
  const pasting = new Set<string>();
  const isOpen = (l: Login | undefined): l is Login => l !== undefined && OPEN.has(l.status);

  const signIns: SignIns = {
    async start(name, x = {}) {
      const source = o.sources().find((s) => s.name === name);
      if (!source) return { ok: false, reason: 'not_found', message: `usage source ${name} not found` };
      if (!source.signIn) return { ok: false, reason: 'no_sign_in', message: `usage source ${name} cannot start its tool's sign-in` };
      let run: ToolSignIn;
      try {
        run = await source.signIn(x.email ? { email: x.email } : {});
      } catch (e) {
        return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
      // One per machine and tool: the one before is cancelled.
      for (const [id, had] of runs) {
        if (had.machineId !== run.machineId || had.tool !== run.tool) continue;
        runs.delete(id);
        had.cancel();
        if (isOpen(logins.get(id))) logins.cancel(id);
      }
      const expiresAt = new Date(o.clock.now().getTime() + SIGN_IN_LIFE_MS).toISOString();
      let login: Login;
      try {
        login = logins.report({ kind: 'paste_code', tool: run.tool, verificationUrl: run.url, expiresAt }, { machineId: run.machineId, run: SIGN_IN_RUN, renewable: false });
      } catch (e) {
        run.cancel();
        return { ok: false, reason: 'not_started', message: `the sign-in did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
      runs.set(login.id, run);
      return { ok: true, login };
    },

    async paste(id, code) {
      const login = logins.get(id);
      if (!login) return { ok: false, reason: 'not_found', message: `login ${id} not found` };
      const run = runs.get(id);
      if (!run || !isOpen(login)) return { ok: false, reason: 'ended', message: `login ${id} is not a sign-in that waits for its code` };
      const problem = codeProblem(code);
      if (problem) return { ok: false, reason: 'bad_code', message: problem };
      runs.delete(id);
      pasting.add(id);
      try {
        const end = await run.paste(code.trim());
        if (end.ok) logins.completed(id);
        else logins.failed(id, end.reason);
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
        if (l.run === SIGN_IN_RUN && !l.jobId && !l.questionId && !runs.has(l.id) && !pasting.has(l.id)) logins.failed(l.id, 'the hopper restarted while the sign-in waited: start it again');
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
