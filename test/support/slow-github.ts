// A GitHub that answers slowly (issue #1194): every call of the port waits `ms` first, then the fake answers. The delay is
// read at each call, so a test sets it once the hopper has synced, and back to 0 to let what runs after the answer end.
import type { GitHubApi } from '../../src/sources/github/api.ts';

export function slowGitHub<T extends GitHubApi>(gh: T): { api: T; delay: { ms: number } } {
  const delay = { ms: 0 };
  const api = new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (delay.ms > 0) await new Promise((res) => setTimeout(res, delay.ms));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { api, delay };
}
