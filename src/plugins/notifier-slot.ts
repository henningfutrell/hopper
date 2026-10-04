// The notifier role's slots (design.md "Failure", "Settled in slice 5"): 0..n instances, a restart
// role built once at start. One that cannot run — unknown plugin, invalid options, unavailable,
// create or start throwing — is dropped with its reason; never a boot failure. One whose detection
// says needs-setup still runs (grokbot-routine reads its env file at each event). Each is named
// after its instance.
import type { Notifier, NotifierEvents } from '../domain/ports.ts';
import type { InstanceSpec } from '../domain/types.ts';
import type { SlotDeps } from './router-slot.ts';
import { buildOne, type Built } from './source-slots.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function buildNotifiers(specs: InstanceSpec[], deps: SlotDeps): Promise<Built<Notifier>[]> {
  const built = await Promise.all(specs.map((spec) => buildOne('notifier', spec, deps, { needsSetupRuns: true })));
  // The instance name wins over the plugin's own; every other member is the plugin's.
  return built.map((b) => (b.instance ? { ...b, instance: Object.create(b.instance, { name: { value: b.spec.name, enumerable: true } }) as Notifier } : b));
}

/** Start each running notifier; one whose start throws is dropped in place (the array is the host's slot). */
export function startNotifiers(built: Built<Notifier>[], events: NotifierEvents, logger: SlotDeps['logger']): void {
  built.forEach((b, i) => {
    if (!b.instance) return;
    try {
      b.instance.start(events);
    } catch (e) {
      const reason = `cannot start: ${message(e)}`;
      logger.warn(`job-hopper: notifier ${b.spec.name} (${b.spec.plugin}) unavailable: ${reason}`);
      built[i] = { spec: b.spec, detection: b.detection, plugin: null, reason };
    }
  });
}

/** Stop every running notifier; a failing stop is logged, never thrown. */
export async function stopNotifiers(built: Built<Notifier>[], logger: SlotDeps['logger']): Promise<void> {
  await Promise.all(built.map(async (b) => {
    try {
      await b.instance?.stop();
    } catch (e) {
      logger.warn(`job-hopper: notifier ${b.spec.name} failed to stop: ${message(e)}`);
    }
  }));
}
