// The shared rate limiter's settings (issue #436, design.md "The shared rate limiter"): the instance's, kept in the
// database, changed by the hopper's admin (POST /ui/api/github-rate-limiter) and given to the process's limiter at
// once, so a change applies to the next call and the next poll round without a restart. Read at start; a change is
// `github_rate_limiter.settings_changed`.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { DEFAULT_RATE_LIMITER, type RateLimiterSettings, type RateLimiterView } from '../domain/github-rate-limit.ts';
import { githubLimiter, type GitHubLimiter } from './limiter.ts';

export interface RateLimiterControl {
  view(): RateLimiterView;
  /** Saves the parts given and applies them; nothing changed, nothing saved. */
  change(patch: Partial<RateLimiterSettings>, by: string): RateLimiterView;
}

export function createRateLimiterControl(o: {
  /** Default: the process's own. */
  limiter?: GitHubLimiter;
  settings: Pick<InstanceSettingsRepository, 'getGitHubRateLimiter' | 'setGitHubRateLimiter'>;
  events: Pick<InstanceEvents, 'append'>;
}): RateLimiterControl {
  const limiter = o.limiter ?? githubLimiter;
  limiter.configure({ ...DEFAULT_RATE_LIMITER, ...o.settings.getGitHubRateLimiter() });
  return {
    view: () => limiter.view(),
    change(patch, by) {
      const from = limiter.settings();
      const to = { ...from, ...patch };
      if (Object.entries(to).some(([k, v]) => from[k as keyof RateLimiterSettings] !== v)) {
        o.settings.setGitHubRateLimiter(to);
        limiter.configure(to);
        o.events.append({ type: 'github_rate_limiter.settings_changed', data: { from, to, by } });
      }
      return limiter.view();
    },
  };
}
