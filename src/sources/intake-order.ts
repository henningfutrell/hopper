// The order new items enter the queue as a decider call (issue #796, design.md "Decider calls"): when one sync of a source
// finds two or more new items — none has a job that follows it —, Jev first (`intake-order`) picks the one that enters
// first, of the first 10 in the source's order (the rules' order). Applied — active and sure —, it is offered first, so its
// job is queued first and goes first among jobs of the same priority; the rest follow in the source's order. Else the
// source's order stands, and a pick not applied is compared with its first. Choosing an order deletes, sends and publishes
// nothing: never consequential. Only the facts of each item go to Jev: never its author or its text.
import type { SourceItem } from '../domain/ports.ts';
import type { JevFirst } from '../domain/types.ts';
import { MAX_ORDER_OPTIONS } from './tend-order.ts';

const INSTRUCTIONS = 'Pick the new item that enters the job queue first. Jobs of the same priority run in the order they enter. '
  + 'Prefer the item others depend on, the higher priority, and the smaller change. The options are in the source\'s order.';

/** `items` as the source listed them, the new one Jev picked first when its pick is applied. `fresh`: no job follows it. */
export async function intakeOrder(jev: JevFirst | undefined, source: string, items: SourceItem[], fresh: (item: SourceItem) => boolean): Promise<SourceItem[]> {
  const options = items.filter(fresh).slice(0, MAX_ORDER_OPTIONS);
  if (!jev || options.length < 2) return items;
  const out = await jev.decide({
    point: 'intake-order', instructions: INSTRUCTIONS, rules: options[0]!.key, consequential: [],
    options: options.map((i) => ({ id: i.key, label: `${i.title} (priority ${i.priority})` })),
    state: {
      source, items: options.map((i) => ({
        option: i.key, title: i.title, priority: i.priority, priorityReason: i.priorityReason, labels: i.labels,
        ...(i.repo ? { repo: i.repo } : {}), ...(i.number !== undefined ? { number: i.number } : {}), ...(i.parts ? { parts: i.parts } : {}),
      })),
    },
  });
  const first = out.asked && out.applied ? options.find((i) => i.key === out.pick) : undefined;
  return first ? [first, ...items.filter((i) => i !== first)] : items;
}
