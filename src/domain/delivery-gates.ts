// Gate clearances (issue #2554 part 5, design.md "Delivery forecasts"): a person's act that ends a delivery gate — the
// test gate's sign-off, a production approval — for one promotion set of a repository, recorded as
// `delivery_gate.cleared`. Each change of that set then goes on past the gate from the clearance. Pure.
import type { DeliveryStep } from './delivery-steps.ts';
import type { DomainEvent } from './types.ts';

/** The answer to a clearance: the gate it names, who cleared it and when. */
export interface DeliveryGateClearanceView { repo: string; set: number; step: DeliveryStep; by: string; at: string }

interface Cleared { repo: string; set: number; step: DeliveryStep; by: string }

/** The clearances of one promotion set of `repo`, per step: the first clearance of each step counts. */
export function gateClearancesOf(events: readonly DomainEvent[], repo: string, set: number): Partial<Record<DeliveryStep, { by: string; at: string }>> {
  const out: Partial<Record<DeliveryStep, { by: string; at: string; seq: number }>> = {};
  for (const e of events) {
    if (e.type !== 'delivery_gate.cleared') continue;
    const c = e.data as unknown as Cleared;
    if (c.repo.toLowerCase() !== repo.toLowerCase() || c.set !== set) continue;
    const had = out[c.step];
    if (!had || e.seq < had.seq) out[c.step] = { by: c.by, at: e.at, seq: e.seq };
  }
  return Object.fromEntries(Object.entries(out).map(([step, c]) => [step, { by: c.by, at: c.at }]));
}
