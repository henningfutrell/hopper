// Priority lanes in placement (issue #535, design.md "High priority everywhere"): a high-priority job takes a free priority
// lane first, on the machine holding the best one. A priority lane is held only on demand (issue #788): while a
// high-priority job still to be placed could run on the machine, other jobs leave it as many free priority lanes as
// those jobs (keep-free), or only low jobs do (share). With none to place, any job takes a priority lane, last. Pure,
// like the rest of the decider.
import { isHighPriority, LOW_PRIORITY_BELOW, type Job, type Lane, type LaneId, type PriorityLanesInput } from '../domain/types.ts';

/** What placement knows of one machine's lanes, beside its counts. */
export interface LaneSlots {
  /** Its priority lanes, best first. */
  priority: LaneId[];
  /** Lanes open now, of any state, and those this Decision opens. */
  openIds: Set<LaneId>;
  /** Lanes busy or draining now, and those this Decision gives a job. */
  inUse: Set<LaneId>;
  /** High-priority jobs still to be placed in this Decision that could run here: the priority lanes held for them. */
  wanted: number;
}

export function laneSlots(machineId: string, lanes: readonly Lane[], input: PriorityLanesInput | undefined): LaneSlots {
  const mine = lanes.filter((l) => l.machineId === machineId);
  return {
    priority: (input?.lanes ?? []).filter((id) => id.startsWith(`${machineId}/lane-`)),
    openIds: new Set(mine.map((l) => l.id)),
    inUse: new Set(mine.filter((l) => l.state !== 'idle').map((l) => l.id)),
    wanted: 0,
  };
}

export const isHigh = (job: Job, input: PriorityLanesInput | undefined): boolean => input !== undefined && isHighPriority(job.priority, input.highPriority);

/** The priority lanes no job holds or takes in this Decision. */
export const freePriority = (s: LaneSlots): LaneId[] => s.priority.filter((id) => !s.inUse.has(id));

/**
 * How many free priority lanes the job must leave there: none for a high-priority job, or in share a job that is not
 * low; else one for each high-priority job still to be placed that could run there (issue #788), at most the free ones.
 */
export function keptFor(s: LaneSlots, job: Job, input: PriorityLanesInput | undefined): number {
  if (!input || isHigh(job, input) || (input.whenIdle === 'share' && job.priority >= LOW_PRIORITY_BELOW)) return 0;
  return Math.min(s.wanted, freePriority(s).length);
}

/** Whether the job may take a priority lane: one is free beyond those it must leave. */
const mayUsePriority = (s: LaneSlots, job: Job, input: PriorityLanesInput | undefined): boolean => freePriority(s).length > keptFor(s, job, input);

const laneId = (machineId: string, n: number): LaneId => `${machineId}/lane-${n}`;

/** The lane a job takes on a machine: an idle one, or one to open (`opens`); `priority` when it is a priority lane. */
export interface LanePick { lane?: Lane; opens?: LaneId; priority?: LaneId }

/**
 * Pick the job's lane on a machine with priority lanes: a high-priority job its best free priority lane; any other
 * job an idle lane off them, else a new one numbered within the machine's lanes, and only then — when it may — a
 * priority lane. Marks what it took. A machine with no priority lanes: undefined, the caller picks as before.
 */
export function pickLane(machineId: string, maxLanes: number, s: LaneSlots, freeIdle: Lane[], job: Job, input: PriorityLanesInput | undefined): LanePick | undefined {
  if (s.priority.length === 0) return undefined;
  const take = (pick: LanePick): LanePick => {
    const id = pick.lane?.id ?? pick.opens!;
    if (pick.lane) freeIdle.splice(freeIdle.indexOf(pick.lane), 1);
    s.openIds.add(id);
    s.inUse.add(id);
    return pick;
  };
  const priorityPick = (): LanePick | undefined => {
    for (const id of freePriority(s)) {
      const idle = freeIdle.find((l) => l.id === id);
      if (idle) return take({ lane: idle, priority: id });
      if (!s.openIds.has(id)) return take({ opens: id, priority: id });
    }
    return undefined;
  };
  if (isHigh(job, input)) {
    const p = priorityPick();
    if (p) return p;
  }
  const idle = freeIdle.find((l) => !s.priority.includes(l.id));
  if (idle) return take({ lane: idle });
  const free = (n: number): boolean => !s.openIds.has(laneId(machineId, n)) && !s.priority.includes(laneId(machineId, n));
  for (let n = 1; n <= maxLanes; n++) if (free(n)) return take({ opens: laneId(machineId, n) });
  if (mayUsePriority(s, job, input)) {
    const p = priorityPick();
    if (p) return p;
  }
  let n = maxLanes + 1;
  while (!free(n)) n++;
  return take({ opens: laneId(machineId, n) });
}

/** Of the machines a high-priority job may go to, the one holding the best free priority lane; undefined: none. */
export function holdingBestFree<T extends { machine: { id: string }; slots: LaneSlots }>(options: T[], input: PriorityLanesInput): T | undefined {
  for (const id of input.lanes) {
    const holder = options.find((o) => o.slots.priority.includes(id) && !o.slots.inUse.has(id));
    if (holder) return holder;
  }
  return undefined;
}

/** `priority lane m/lane-1` or `priority lanes m/lane-1, m/lane-2`. */
export const priorityLaneNames = (ids: readonly LaneId[]): string => `priority lane${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;
