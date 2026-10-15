// A machine leaving the hopper (design.md "Lane pods", issue #1284): `POST /client/leave`, signed with the client token
// (signature.ts signLeave). From the first ask the hopper places no new job on the machine; each answer says how many
// of its jobs are still on it, and whether the hopper retired it (a lane pod with no job left). A lane pod's client
// asks when it is told to stop (HOPPER_CLIENT_DRAIN), again and again, until no job is left on it; then it stops. The
// pod's grace period is the most it waits: what is still on it then is a job on a machine that went away.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { LEAVE_PATH, MACHINE_KEY_HEADER, USER_HEADER } from './link.ts';
import { REQUEST_HEADER, signLeave } from './signature.ts';

/** The hopper's answer: the jobs still on the machine, and whether it is retired (gone from the hopper's machines). */
export interface LeaveAnswer { jobs: number; retired: boolean }

/** Asks once. Rejects when the hopper cannot be reached or refuses, saying why. */
export const leaveHopper = (o: { url: string; user: string; key: string; token: () => string }) => async (): Promise<LeaveAnswer> => {
  let res: Response;
  try {
    res = await fetch(new URL(LEAVE_PATH, o.url), {
      method: 'POST', headers: { [USER_HEADER]: o.user, [MACHINE_KEY_HEADER]: o.key, [REQUEST_HEADER]: signLeave(o.token(), o.user, o.key) },
    });
  } catch (e) {
    throw new Error(`could not reach the hopper at ${o.url}: ${(e as Error).message}`, { cause: e });
  }
  const text = await res.text();
  let body: { jobs?: unknown; retired?: unknown; error?: unknown } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`the hopper refused the leave (${res.status}): ${typeof body.error === 'string' ? body.error : text.slice(0, 200)}`);
  return { jobs: typeof body.jobs === 'number' ? body.jobs : 0, retired: body.retired === true };
};

/** Asks until no job is left on the machine (or it is retired), every `everyMs`; a failed ask is tried again. */
export async function drain(o: { leave: () => Promise<LeaveAnswer>; everyMs?: number; log?: (line: string) => void }): Promise<LeaveAnswer> {
  for (;;) {
    try {
      const a = await o.leave();
      if (a.retired || a.jobs === 0) {
        o.log?.(`hopper-client: left the hopper${a.retired ? ': this machine is retired' : ''}`);
        return a;
      }
      o.log?.(`hopper-client: leaving: ${a.jobs} job${a.jobs === 1 ? '' : 's'} still on this machine, no new one placed`);
    } catch (e) {
      o.log?.(`hopper-client: leaving: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, o.everyMs ?? 5000));
  }
}
