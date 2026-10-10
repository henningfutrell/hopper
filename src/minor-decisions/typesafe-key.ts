// The user's TypeSafe API key (issue #657, design.md "The TypeSafe API key in the vault's system scope"): the hopper's own secret, set on the Jev page or by
// the operator CLI and kept in the vault's system scope (src/vault/system.ts), not given by the runtime. A key is checked
// once against TypeSafe before it is kept: one that fails is not kept, and the error says why with the key masked. Jev
// asks `value()` at each decision, so a set, a replace or a removal applies at once. A key the runtime still gives
// (`<secret prefix>TYPESAFE_API_KEY`, the source before) is imported once, when none is kept, and never read again; the
// view names the variable while it is set, so a person removes it. Nothing here logs, answers or appends the key.
import type { UserSettingsRepository } from '../domain/ports.ts';
import type { JevChooser, TypesafeKeyView } from '../domain/types.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { maskSecret } from '../secrets/mask.ts';
import type { SystemChanger, SystemResult, SystemSecrets } from '../vault/system.ts';

/** The runtime's name of the key before issue #657, under the user's secret prefix. */
export const TYPESAFE_KEY_VARIABLE = 'TYPESAFE_API_KEY';
const NAME = 'typesafe-api-key';
/** The one-time import's record among the user's backfills. */
const IMPORT = 'typesafe-key-import';

export type TypesafeKeyResult = { ok: true; view: TypesafeKeyView } | Exclude<SystemResult, { ok: true }>;

export interface TypesafeKey {
  /** The key now, opened from the vault; undefined when none is kept or it cannot be opened (the view says why). */
  value(): string | undefined;
  view(): TypesafeKeyView;
  /** Checks `value` against TypeSafe, then keeps it in place of any key kept. */
  set(value: string, who: SystemChanger): Promise<TypesafeKeyResult>;
  remove(who: SystemChanger): Promise<TypesafeKeyResult>;
  /** At start: the key the runtime gives, kept once when none is. */
  importFromEnvironment(): void;
}

export function createTypesafeKey(o: {
  system: SystemSecrets;
  jev: Pick<JevChooser, 'check'>;
  /** The runtime's secrets, under the user's secret prefix; `variable`: that name as the runtime knows it. */
  runtime: RuntimeSecrets;
  variable: string;
  backfills: Pick<UserSettingsRepository, 'getBackfills' | 'setBackfills'>;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}): TypesafeKey {
  const unreadable = new Set<string>();
  /** The key, or why it cannot be opened. */
  const opened = (): { value?: string; problem?: string } => {
    try {
      const value = o.system.open(NAME);
      return value === undefined ? {} : { value };
    } catch (e) {
      const problem = (e as Error).message;
      if (!unreadable.has(problem)) { unreadable.add(problem); o.logger.warn(`hopper: the TypeSafe API key: ${problem}`); }
      return { problem };
    }
  };
  /** Whether the runtime still gives the variable: never its value. */
  const inEnvironment = (): boolean => {
    try { return o.runtime(TYPESAFE_KEY_VARIABLE) !== undefined; } catch { return true; }
  };

  function view(): TypesafeKeyView {
    const { value, problem } = opened();
    const meta = o.system.meta(NAME);
    const cannot = problem ?? o.system.problem();
    return {
      set: meta !== undefined,
      ...(value !== undefined ? { last4: value.slice(-4) } : {}),
      ...(meta ? { setAt: meta.setAt, setBy: meta.setBy } : {}),
      ...(inEnvironment() ? { environment: { variable: o.variable } } : {}),
      ...(cannot ? { problem: cannot } : {}),
    };
  }

  const done = (r: SystemResult): TypesafeKeyResult => (r.ok ? { ok: true, view: view() } : r);

  return {
    value: () => opened().value,
    view,
    async set(raw, who) {
      const value = raw.trim();
      if (!value) return { ok: false, code: 'invalid', error: 'the key is empty' };
      const cannot = o.system.problem();
      if (cannot) return { ok: false, code: 'unavailable', error: cannot };
      const checked = await o.jev.check(value);
      if (!checked.ok) {
        return { ok: false, code: 'invalid', error: `the key was not saved: the check against TypeSafe failed: ${maskSecret(checked.why, value, 'TypeSafe API key')}` };
      }
      return done(await o.system.set(NAME, value, who));
    },
    async remove(who) {
      return done(await o.system.remove(NAME, who));
    },
    importFromEnvironment() {
      const backfills = o.backfills.getBackfills();
      if (backfills[IMPORT] !== undefined) return;
      let value: string | undefined;
      try { value = o.runtime(TYPESAFE_KEY_VARIABLE)?.trim() || undefined; } catch (e) { o.logger.warn(`hopper: ${(e as Error).message}`); return; }
      if (value === undefined) return;
      const mark = () => o.backfills.setBackfills({ ...backfills, [IMPORT]: o.clock.now().toISOString() });
      if (o.system.meta(NAME)) { mark(); return; }
      const r = o.system.keep(NAME, value, 'environment');
      if (!r.ok) { o.logger.warn(`hopper: ${o.variable}: the TypeSafe API key cannot be imported into the vault: ${r.error}`); return; }
      mark();
      o.logger.info(`hopper: ${o.variable}: the TypeSafe API key is imported from the environment into the vault; remove it from the environment (the hopper does not read it again)`);
    },
  };
}
