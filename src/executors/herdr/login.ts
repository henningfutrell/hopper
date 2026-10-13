// A herdr-claude job that waits on a login (issue #476, design.md "Logins"): the fields it reported after
// HOPPER_AUTH_PENDING as a login report, and what the hopper types into its pane when the user acts on it.
import type { ExecutionContext } from '../../domain/ports.ts';
import { LOGIN_KINDS, type LoginCheck, type LoginKind, type LoginReport } from '../../domain/types.ts';
import { DEFAULT_EXPIRES_IN_SEC } from '../../logins/recognise.ts';
import type { LoginSignal } from '../../logins/signals.ts';
import type { LoginWait } from './monitor.ts';
import { readTurn, type AuthFields } from './screen.ts';

/** The login a job waits on, as its executor state keeps it. */
export interface LoginRef { id: string; tool: string }

/** Logins in a row the hopper could not take before the job fails: each one is a turn. */
const MAX_UNREADABLE = 3;

const HOW = 'a line containing only HOPPER_AUTH_PENDING, then one line each: tool: <the command>, url: <the URL>, code: <the code>, expires_in: <seconds until the code expires>';

/** Typed in when the user cancels the login. */
export const loginCancelledNote = (tool: string): string => `[hopper] The user cancelled the ${tool} login. Stop the command that waits for it, then go on without it; if the job cannot be done without it, end with a line HOPPER_FAILED followed by the reason.`;

/** Typed in when the job's screen shows a device code it did not report (issue #698): the user was told; report it. */
export const loginSeenNote = (tool: string): string => `[hopper] Your screen shows a ${tool} login code. The user was shown the link and the code (Logins). Keep the command that waits for it running in the background. Report it: end your message with ${HOW}.`;

/** Typed in when the code expired and the hopper asks for a new one by itself (`onExpiry: renew`, issue #1016). */
export const loginExpiredNewCodeNote = (tool: string): string => `[hopper] The ${tool} code expired before the user completed the login. Stop the command that waits for it, start the login again in the background, and end your message with ${HOW}.`;

/** Typed in when the user asks for a new code. */
export const loginNewCodeNote = (tool: string): string => `[hopper] The user asked for a new code for the ${tool} login. Stop the command that waits for it, start the login again in the background, and end your message with ${HOW}.`;

/**
 * Whether a login is GitHub's (issue #563): `gh`, or a device page on github.com. A job never logs in to GitHub
 * itself; the hopper does GitHub for it.
 */
export function isGitHubLogin(r: Pick<LoginReport, 'tool' | 'verificationUrl'>): boolean {
  if (/^gh(\s|$)/.test(r.tool.trim())) return true;
  try {
    const u = new URL(r.verificationUrl);
    return /(^|\.)github\.com$/i.test(u.hostname) && u.pathname.startsWith('/login/device');
  } catch {
    return false;
  }
}

/** Typed in, once, when a job reports a GitHub login (issue #563): ask the hopper instead. */
export const githubLoginNote = (tool: string): string => `[hopper] Do not log in to GitHub on this machine: stop the ${tool} login (the command waiting for it) without entering the code. The hopper does GitHub for this job with its own connection: run sh "$HOPPER_GH" help to see how, and use it for what you needed the login for. If HOPPER_GH is not set, the hopper cannot be reached from this machine, or it cannot do what you need, end with a line HOPPER_FAILED followed by the reason. Never report a GitHub login again and never ask for one: the job fails if you do.`;

/** Why a job that reports a GitHub login again, after it was steered, fails (issue #695): a job never signs in to GitHub. */
export const GITHUB_LOGIN_AGAIN = 'the job reported a GitHub login again after it was told to use the hopper: a job never signs in to GitHub, not even to get around a hopper it cannot reach (issue #695). Look at the job\'s last progress for why the hopper did not serve it';

/** Typed in when the login the job reported cannot be taken. */
export const loginUnreadableNote = (problem: string): string => `[hopper] The login you reported could not be taken: ${problem}. Report it again: end your message with ${HOW}.`;

const positiveInt = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);

/** The login the job reported, or why it cannot be one. Its kind checks the rest when it is reported. */
export function loginReportOf(f: AuthFields, now: Date): LoginReport | { problem: string } {
  const kind = (f.kind ?? 'device_code').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(LOGIN_KINDS as readonly string[]).includes(kind)) return { problem: `kind ${f.kind} is not one the hopper takes (${LOGIN_KINDS.join(', ')})` };
  const tool = f.tool?.trim();
  if (!tool) return { problem: 'it names no tool' };
  if (!f.url?.trim()) return { problem: 'it names no URL' };
  let expiresAt: string;
  if (f.expires_at !== undefined) {
    const at = Date.parse(f.expires_at);
    if (Number.isNaN(at)) return { problem: `expires_at ${f.expires_at} is no time` };
    expiresAt = new Date(at).toISOString();
  } else {
    const seconds = f.expires_in === undefined ? DEFAULT_EXPIRES_IN_SEC : positiveInt(f.expires_in);
    if (seconds === undefined) return { problem: `expires_in ${f.expires_in} is not a number of seconds` };
    expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  }
  const intervalSec = positiveInt(f.interval);
  // What asks, when the tool shows it (issue #698): the account, and the scopes as a list.
  const scopes = f.scopes?.split(/[\s,]+/).filter(Boolean) ?? [];
  return {
    kind: kind as LoginKind, tool, verificationUrl: f.url.trim(), ...(f.code?.trim() ? { userCode: f.code.trim() } : {}), expiresAt,
    ...(intervalSec ? { intervalSec } : {}), ...(f.account?.trim() ? { account: f.account.trim() } : {}), ...(scopes.length ? { scopes } : {}),
  };
}

/**
 * A turn that ended on a login: reported to the logins (the job then waits), or said back to the job when it
 * cannot be taken, `unreadable` times in a row at most before the job fails. A GitHub login is steered to the
 * hopper's GitHub proxy instead (`steered`, issue #563); reported again right after, the job fails (issue #695): a GitHub
 * sign-in never goes to the user. The login it already waits on, reported again (a script polling, Claude checking on it,
 * issue #567), is the same login and says nothing new. A login `seen` on screen, not reported (issue #698), is reported
 * all the same, and the job is told to report it (`say` with its `login`). Its code joins `codes`, the job's known ones.
 */
export function takeLogin(
  ctx: ExecutionContext, fields: AuthFields, now: Date, unreadable: number, steered = false, waitsOn?: LoginRef, o: { seen?: boolean; codes?: Set<string> } = {},
): { login: LoginRef } | { say: string; steered?: true; login?: LoginRef } | { failed: string } {
  if (fields.code) o.codes?.add(fields.code.trim());
  const report = loginReportOf(fields, now);
  // Reported again right after it was steered (issue #695): never taken to the user; the job fails.
  if (!('problem' in report) && steered && isGitHubLogin(report)) return { failed: GITHUB_LOGIN_AGAIN };
  if (!('problem' in report) && !steered && !waitsOn && isGitHubLogin(report)) {
    ctx.progress(`the job started a ${report.tool} login: told it to ask the hopper for GitHub instead`);
    return { say: githubLoginNote(report.tool), steered: true };
  }
  let problem = 'problem' in report ? report.problem : ctx.logins ? undefined : 'this hopper takes no logins';
  if (!problem && !('problem' in report)) {
    try {
      const id = ctx.logins!.report(report, { renewable: true });
      if (id === waitsOn?.id) return { login: waitsOn };
      const login = { id, tool: report.tool };
      ctx.progress(`waiting for the ${login.tool} login: the user completes it (Logins)`);
      return o.seen ? { say: loginSeenNote(login.tool), login } : { login };
    } catch (e) { problem = (e as Error).message; }
  }
  if (unreadable > MAX_UNREADABLE) return { failed: `the login the job reported could not be taken: ${problem}` };
  return { say: loginUnreadableNote(problem ?? 'unknown') };
}

/**
 * The login as the monitor waits on it: what the user did, and a login signal on screen (issue #567) — completed,
 * expired, or denied at the provider. Only a signal ends it; Claude going on by itself never does.
 */
export function loginWait(ctx: ExecutionContext, login: LoginRef, cleared: () => void): LoginWait {
  return {
    check: () => ctx.logins?.check(login.id) ?? { act: 'wait' },
    signal: (s: LoginSignal) => {
      if (s === 'expired') {
        ctx.logins?.expired(login.id);
        ctx.progress(`the ${login.tool} code expired before the login was completed`);
        return;
      }
      if (s === 'completed') ctx.logins?.completed(login.id);
      else ctx.logins?.failed(login.id, `the ${login.tool} login was denied at the provider`);
      cleared();
      ctx.progress(s === 'completed' ? `the ${login.tool} login went through: claude goes on` : `the ${login.tool} login was denied at the provider`);
    },
  };
}

/** What the user did with the login, as the job hears it: it fails, or a note typed in. A new code keeps the login open. */
export function afterLoginAct(said: Exclude<LoginCheck, { act: 'wait' } | { act: 'ended' }>, tool: string): { failed: string } | { say: string; progress: string } {
  if (said.act === 'fail') return { failed: said.reason };
  if (said.act === 'cancelled') return { say: loginCancelledNote(tool), progress: `the user cancelled the ${tool} login: told claude` };
  if (said.expired) return { say: loginExpiredNewCodeNote(tool), progress: `the ${tool} code expired: asked the job for a new ${tool} code` };
  return { say: loginNewCodeNote(tool), progress: `the user asked for a new ${tool} code: told claude` };
}

/** After a restart: the login's URL and code back from the screen, while Claude still waits on it there (they went with the process). */
export function restoreLogin(ctx: ExecutionContext, screen: string, anchor: string, login: LoginRef, now: Date): void {
  const t = readTurn(screen, anchor);
  const report = t.lastMarker === 'auth' && t.auth ? loginReportOf(t.auth, now) : undefined;
  if (!report || 'problem' in report || report.tool !== login.tool) return;
  try { ctx.logins?.report(report, { renewable: true, restore: true }); } catch { /* the login then shows its code as not kept */ }
}
