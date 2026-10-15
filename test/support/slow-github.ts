// A GitHub that answers slowly or not at all (issue #1194). `delay.ms`: every call of the port waits that long first,
// read at each call. `hold()`: every call from then on waits until `release()`, so an action that waited for GitHub
// would never answer — a test of the order that needs no clock. Then the fake answers.
import type { GitHubApi } from '../../src/sources/github/api.ts';

export function slowGitHub<T extends GitHubApi>(gh: T): { api: T; delay: { ms: number }; hold(): void; release(): void } {
  const delay = { ms: 0 };
  let held: { done: Promise<void>; open: () => void } | undefined;
  const api = new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (held) await held.done;
        if (delay.ms > 0) await new Promise((res) => setTimeout(res, delay.ms));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    api, delay,
    hold() {
      if (held) return;
      let open = () => {};
      const done = new Promise<void>((res) => { open = res; });
      held = { done, open };
    },
    release() {
      held?.open();
      held = undefined;
    },
  };
}
