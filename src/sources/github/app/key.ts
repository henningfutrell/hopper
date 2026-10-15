// The GitHub App's private key (issue #1243, design.md "The GitHub App's private key in the vault"): the hopper's own
// secret, set through the write-only field on the app source's setup card (or the API) and kept in the vault's system
// scope (src/vault/system.ts), not given by the runtime. A value is checked to be a private key before it is kept: one
// that is not is not kept, and the error never carries it. The source reads `value()` at each sync, so a set, a replace
// or a removal applies at the next one, without a restart. A key the runtime still gives (`<secret prefix>
// GITHUB_APP_PRIVATE_KEY`, the source before) is imported once, when none is kept, and never read again; the view names
// the variable while it is set, so a person removes it. Nothing here logs, answers or appends the key.
import { createPrivateKey } from 'node:crypto';
import type { UserSettingsRepository } from '../../../domain/ports.ts';
import type { GitHubAppKeyView } from '../../../domain/types.ts';
import type { RuntimeSecrets } from '../../../secrets/runtime.ts';
import type { SystemChanger, SystemResult, SystemSecrets } from '../../../vault/system.ts';
import { pemFromEnv } from './config.ts';

/** The runtime's name of the key before issue #1243, under the user's secret prefix: what the app source reads it by. */
export const GITHUB_APP_KEY_VARIABLE = 'GITHUB_APP_PRIVATE_KEY';
const NAME = 'github-app-private-key';
/** The one-time import's record among the user's backfills. */
const IMPORT = 'github-app-key-import';

export type GitHubAppKeyResult = { ok: true; view: GitHubAppKeyView } | Exclude<SystemResult, { ok: true }>;

export interface GitHubAppKey {
  /** The key now, opened from the vault; undefined when none is kept or it cannot be opened (the view says why). */
  value(): string | undefined;
  view(): GitHubAppKeyView;
  /** Checks that `value` is a private key, then keeps it in place of any key kept. */
  set(value: string, who: SystemChanger): Promise<GitHubAppKeyResult>;
  remove(who: SystemChanger): Promise<GitHubAppKeyResult>;
  /** At start: the key the runtime gives, kept once when none is. */
  importFromEnvironment(): void;
}

export function createGitHubAppKey(o: {
  system: SystemSecrets;
  /** The runtime's secrets, under the user's secret prefix; `variable`: that name as the runtime knows it. */
  runtime: RuntimeSecrets;
  variable: string;
  backfills: Pick<UserSettingsRepository, 'getBackfills' | 'setBackfills'>;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}): GitHubAppKey {
  const unreadable = new Set<string>();
  /** The key, or why it cannot be opened. */
  const opened = (): { value?: string; problem?: string } => {
    try {
      const value = o.system.open(NAME, 'the GitHub App source');
      return value === undefined ? {} : { value };
    } catch (e) {
      const problem = (e as Error).message;
      if (!unreadable.has(problem)) { unreadable.add(problem); o.logger.warn(`hopper: the GitHub App's private key: ${problem}`); }
      return { problem };
    }
  };
  /** Whether the runtime still gives the variable: never its value. */
  const inEnvironment = (): boolean => {
    try { return o.runtime(GITHUB_APP_KEY_VARIABLE) !== undefined; } catch { return true; }
  };

  function view(): GitHubAppKeyView {
    const { problem } = opened();
    const meta = o.system.meta(NAME);
    const cannot = problem ?? o.system.problem();
    return {
      set: meta !== undefined,
      ...(meta ? { setAt: meta.setAt, setBy: meta.setBy } : {}),
      ...(inEnvironment() ? { environment: { variable: o.variable } } : {}),
      ...(cannot ? { problem: cannot } : {}),
    };
  }

  const done = (r: SystemResult): GitHubAppKeyResult => (r.ok ? { ok: true, view: view() } : r);

  return {
    value: () => opened().value,
    view,
    async set(raw, who) {
      if (!raw.trim()) return { ok: false, code: 'invalid', error: 'the key is empty' };
      const value = pemFromEnv(raw);
      try {
        createPrivateKey(value);
      } catch {
        return { ok: false, code: 'invalid', error: 'the key was not saved: it is not a private key in PEM form (-----BEGIN … PRIVATE KEY-----)' };
      }
      const cannot = o.system.problem();
      if (cannot) return { ok: false, code: 'unavailable', error: cannot };
      return done(await o.system.set(NAME, value, who));
    },
    async remove(who) {
      return done(await o.system.remove(NAME, who));
    },
    importFromEnvironment() {
      const backfills = o.backfills.getBackfills();
      if (backfills[IMPORT] !== undefined) return;
      let value: string | undefined;
      try { value = o.runtime(GITHUB_APP_KEY_VARIABLE)?.trim() || undefined; } catch (e) { o.logger.warn(`hopper: ${(e as Error).message}`); return; }
      if (value === undefined) return;
      const mark = () => o.backfills.setBackfills({ ...backfills, [IMPORT]: o.clock.now().toISOString() });
      if (o.system.meta(NAME)) { mark(); return; }
      const r = o.system.keep(NAME, pemFromEnv(value), 'environment');
      if (!r.ok) { o.logger.warn(`hopper: ${o.variable}: the GitHub App's private key cannot be imported into the vault: ${r.error}`); return; }
      mark();
      o.logger.info(`hopper: ${o.variable}: the GitHub App's private key is imported from the environment into the vault; remove it from the environment (the hopper does not read it again)`);
    },
  };
}
