// The notifier role's slots (design.md "Failure", "Settled in slice 5"): 0..n instances, following the
// plugins config live (issue #356): a new or changed one is started with the event feed once the feed
// runs, one no longer named is stopped. One that cannot run — unknown plugin, invalid options, unavailable,
// create or start throwing — is dropped with its reason; never a boot failure. One whose detection
// says needs-setup still runs (grokbot-routine reads its env file at each event). Each is named
// after its instance.
import type { Notifier, NotifierEvents } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';
import type { SlotDeps } from './router-slot.ts';
import { buildOne, type Built } from './source-slots.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function buildNotifier(spec: InstanceSpec, deps: SlotDeps): Promise<Built<Notifier>> {
  const b = await buildOne('notifier', spec, deps, { needsSetupRuns: true });
  // The instance name wins over the plugin's own; every other member is the plugin's.
  return b.instance ? { ...b, instance: Object.create(b.instance, { name: { value: b.spec.name, enumerable: true } }) as Notifier } : b;
}

/** Start a running notifier; one whose start throws comes back dropped, with its reason. */
export function startNotifier(b: Built<Notifier>, events: NotifierEvents, logger: SlotDeps['logger']): Built<Notifier> {
  if (!b.instance) return b;
  try {
    b.instance.start(events);
    return b;
  } catch (e) {
    const reason = `cannot start: ${message(e)}`;
    logger.warn(`hopper: notifier ${b.spec.name} (${b.spec.plugin}) unavailable: ${reason}`);
    return { spec: b.spec, detection: b.detection, plugin: null, reason };
  }
}

/** Stop every running notifier; a failing stop is logged, never thrown. */
export async function stopNotifiers(built: Built<Notifier>[], logger: SlotDeps['logger']): Promise<void> {
  await Promise.all(built.map(async (b) => {
    try {
      await b.instance?.stop();
    } catch (e) {
      logger.warn(`hopper: notifier ${b.spec.name} failed to stop: ${message(e)}`);
    }
  }));
}
