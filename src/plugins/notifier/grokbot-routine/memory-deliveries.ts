// Notifier deliveries kept in memory (issue #1587): what the notifier keeps them in when its feed gives no store
// (`NotifierEvents.deliveries` absent). The same port as the user's store; nothing outlives the process.
import type { NotifierDelivery, NotifierDeliveryRepository } from '../../../domain/notifier-deliveries.ts';
import type { Clock } from '../../sdk.ts';

export function memoryNotifierDeliveries(clock: Clock): NotifierDeliveryRepository {
  const rows = new Map<string, NotifierDelivery>();
  let n = 0;
  return {
    add(input) {
      if ([...rows.values()].some((r) => r.notifier === input.notifier && r.key === input.key)) return undefined;
      const at = clock.now().toISOString();
      const d: NotifierDelivery = { ...input, id: `memory-${++n}`, status: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at };
      rows.set(d.id, d);
      return d;
    },
    update(id, patch) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next: Record<string, unknown> = { ...cur, updatedAt: clock.now().toISOString() };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]; else next[k] = v;
      rows.set(id, next as unknown as NotifierDelivery);
      return next as unknown as NotifierDelivery;
    },
    due: (notifier, now) => [...rows.values()]
      .filter((r) => r.notifier === notifier && (r.status === 'pending' || r.status === 'retrying') && r.nextAttemptAt !== undefined && r.nextAttemptAt <= now.toISOString())
      .sort((a, b) => a.nextAttemptAt!.localeCompare(b.nextAttemptAt!)),
    prune(before) {
      let gone = 0;
      for (const r of [...rows.values()]) if ((r.status === 'delivered' || r.status === 'failed') && r.updatedAt < before && rows.delete(r.id)) gone++;
      return gone;
    },
  };
}
