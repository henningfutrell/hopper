// A push kept as a saga (issue #1806, the owner's decision: pushes are durable work items, issue #1524; design.md "A push
// kept as a saga"). The git broker keeps each push that it sends to GitHub as a `git-push` saga, keyed by the job and the
// request, before GitHub has it: its refs, each from `old` to `new`, and who acts. Its one step, `settle`, ends when the
// push's event is recorded. On the hopper that sends the push, the step waits for the push's answer, which the broker
// records. A hopper that stops meanwhile records nothing; the next hopper, this one or another, takes the saga, and reads
// the refs on GitHub with the user's connection: a ref at `new` is pushed, recorded as `github_proxy.done`; the others
// are recorded as `github_proxy.failed`. An event the broker recorded before the stop is not recorded again (`recorded`).
// git's push is a compare-and-swap of each ref, so nothing here pushes again: the job's git sends it again, if it must.
import type { SagaDefinition, SagaStepContext } from '../sagas/coordinator.ts';
import type { RefUpdate } from './git.ts';
import type { GitConnection, GitUser } from './git-broker.ts';

export const GIT_PUSH_SAGA = 'git-push';

/** The events that record a push the broker sent to GitHub, by its request. */
export const PUSH_EVENTS = ['github_proxy.done', 'github_proxy.failed'] as const;

/** What the saga of a push keeps: what its event names, and the repository whose account acts (`via`). */
export type GitPushData = {
  jobId: string;
  requestId: string;
  repo: string;
  refs: RefUpdate[];
  direct?: string[];
  machine?: string;
  as?: string;
  via?: string;
};

export interface GitPushes {
  /** Keeps the push as a saga, before it reaches GitHub. `settled`: its event is recorded, so the saga ends. */
  begin(userId: string, data: GitPushData): { settled(): void };
  saga: SagaDefinition;
}

/** The refs GitHub has for `repo`, as git's ref advertisement says them: each ref to its commit. */
async function refsOn(git: GitConnection, repo: string, call: typeof fetch): Promise<Map<string, string>> {
  const url = `${git.url.replace(/\/+$/, '')}/${repo}.git/info/refs?service=git-upload-pack`;
  const send = async (token: string) => call(url, { headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, 'user-agent': 'git/hopper' } });
  let token = await git.token();
  let res = await send(token);
  if (res.status === 401) { await res.body?.cancel(); token = await git.renew(token); res = await send(token); }
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status} to the refs of ${repo}`);
  const body = Buffer.from(await res.arrayBuffer());
  const refs = new Map<string, string>();
  for (let at = 0; at + 4 <= body.length;) {
    const size = parseInt(body.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(size)) throw new Error(`not a ref advertisement of ${repo}`);
    if (size < 4) { at += 4; continue; }
    const line = body.toString('utf8', at + 4, at + size).split('\0')[0]!.replace(/\n$/, '');
    const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (m) refs.set(m[2]!, m[1]!);
    at += size;
  }
  return refs;
}

export function createGitPushes(o: {
  user(id: string): GitUser | undefined;
  begin(key: string, data: GitPushData, userId: string): void;
  /** GitHub, as git reaches it; tests give a fake. Default: the global fetch. */
  fetch?: typeof fetch;
}): GitPushes {
  const call = o.fetch ?? fetch;
  /** The pushes this process sends now, by request: each settles once its event is recorded. */
  const inFlight = new Map<string, Promise<void>>();

  const settle = async (c: SagaStepContext): Promise<void> => {
    const data = c.data as unknown as GitPushData;
    const here = inFlight.get(data.requestId);
    if (here) { await here; return; }
    const side = c.saga.userId !== undefined ? o.user(c.saga.userId) : undefined;
    if (!side) throw new Error(`the runtime of user ${c.saga.userId ?? '(none)'} is not loaded`);
    if (side.recorded?.(data.jobId, data.requestId)) return;
    const git = side.git(data.via);
    if ('problem' in git) throw new Error(git.problem);
    const heads = await refsOn(git, data.repo, call);
    const moved = data.refs.filter((r) => heads.get(r.ref) === r.new);
    const left = data.refs.filter((r) => !moved.includes(r));
    const base = { requestId: data.requestId, ...(data.machine ? { machine: data.machine } : {}), ...(data.as ? { as: data.as } : {}), op: 'git.push', repo: data.repo };
    if (moved.length > 0) {
      const direct = (data.direct ?? []).filter((ref) => moved.some((r) => r.ref === ref));
      side.user.record({ type: 'github_proxy.done', jobId: data.jobId, data: { ...base, refs: moved.map((r) => r.ref), ...(direct.length > 0 ? { direct } : {}) } });
    }
    if (left.length > 0) {
      side.user.record({ type: 'github_proxy.failed', jobId: data.jobId, data: { ...base, refs: left.map((r) => r.ref), error: 'the hopper stopped before GitHub answered the push, and GitHub does not have it: push again' } });
    }
  };

  return {
    begin(userId, data) {
      let settled!: () => void;
      inFlight.set(data.requestId, new Promise<void>((resolve) => { settled = resolve; }));
      o.begin(`${data.jobId}/${data.requestId}`, data, userId);
      return { settled: () => { inFlight.delete(data.requestId); settled(); } };
    },
    saga: { kind: GIT_PUSH_SAGA, steps: [{ name: 'settle', do: settle }] },
  };
}
