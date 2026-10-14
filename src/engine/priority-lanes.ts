// Priority lanes (issue #535, design.md "High priority everywhere"): the user's settings, stored and read at each
// Decision; each lane measured from the event log over the window, again at most every MEASURE_MS or at once after a
// settings change; the most reliable lanes chosen with hysteresis, or an admin's; the choice kept in the store so a
// restart neither loses it nor flaps it. A change of the choice is `priority_lanes.changed`; saving the settings is
// `priority_lanes.settings_changed`, which wakes the engine.
import {
  DEFAULT_PRIORITY_LANE_SETTINGS, PRIORITY_LANE_BOUNDS, PRIORITY_LANE_IDLE, prioritySettingsOf,
  type LaneId, type MachineSnapshot, type PriorityLaneSettings, type PriorityLanesInput, type PriorityLanesView,
} from '../domain/types.ts';
import { measure, RUN_EVENTS, runsFrom } from '../reliability/measure.ts';
import { rank, SWITCH_MARGIN, type LaneSlot, type Ranking } from '../reliability/rank.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** How long a measurement is used before the lanes are measured again. */
export const MEASURE_MS = 30_000;

const DAY_MS = 86_400_000;

/** A settings change: any field; `manual: null` goes back to choosing by reliability. */
export type PriorityLaneSettingsPatch = Partial<Omit<PriorityLaneSettings, 'manual'>> & { manual?: LaneId[] | null };

export interface PriorityLanes {
  settings(): PriorityLaneSettings;
  /** What the decider reads now: the priority lanes over these machines, measured again when due. */
  input(machines: readonly MachineSnapshot[]): PriorityLanesInput;
  /** The settings, the choice and every lane's figures with why. */
  view(): Promise<PriorityLanesView>;
  /** Save a settings change (admin): checked against the bounds and the machines' lanes; throws EngineError `invalid`. */
  setSettings(patch: PriorityLaneSettingsPatch): Promise<PriorityLaneSettings>;
}

/** Every lane a machine has: its lane numbers up to its lane count. */
export function slotsOf(machines: readonly MachineSnapshot[]): LaneSlot[] {
  return machines.flatMap((m) => Array.from({ length: m.maxLanes }, (_, i) => ({ laneId: `${m.id}/lane-${i + 1}`, machineId: m.id, online: m.online })));
}

function checked(patch: PriorityLaneSettingsPatch, was: PriorityLaneSettings, slots: readonly LaneSlot[]): PriorityLaneSettings {
  const next: PriorityLaneSettings = { ...was, ...patch, manual: patch.manual === null ? undefined : patch.manual ?? was.manual };
  if (next.manual === undefined) delete next.manual;
  const whole = (k: keyof typeof PRIORITY_LANE_BOUNDS): void => {
    const v = next[k];
    const b = PRIORITY_LANE_BOUNDS[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) throw new EngineError('invalid', `${k} must be a whole number from ${b.min} to ${b.max}`);
  };
  for (const k of Object.keys(PRIORITY_LANE_BOUNDS) as (keyof typeof PRIORITY_LANE_BOUNDS)[]) whole(k);
  if (!(PRIORITY_LANE_IDLE as readonly string[]).includes(next.whenIdle)) throw new EngineError('invalid', `whenIdle must be one of ${PRIORITY_LANE_IDLE.join(', ')}`);
  if (next.manual) {
    const known = new Set(slots.map((s) => s.laneId));
    const unknown = next.manual.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new EngineError('invalid', `no machine has lane ${unknown.join(', ')}`);
    if (new Set(next.manual).size !== next.manual.length) throw new EngineError('invalid', 'a lane is named twice');
  }
  return next;
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function createPriorityLanes(c: EngineContext): PriorityLanes {
  const { store } = c;
  let measured: { at: number; machines: string; ranking: Ranking; measuredAt: string } | undefined;
  /** Set by a settings change: the next measurement says the choice moved `by: settings`. */
  let changedBySettings = false;

  const settings = (): PriorityLaneSettings => prioritySettingsOf(store.settings.getPriorityLanes());
  const machinesKey = (machines: readonly MachineSnapshot[]): string => machines.map((m) => `${m.id}:${m.maxLanes}:${m.online}`).join(',');

  function ranking(machines: readonly MachineSnapshot[]): Ranking {
    const now = c.clock.now().getTime();
    const key = machinesKey(machines);
    if (measured && !changedBySettings && measured.machines === key && now - measured.at < MEASURE_MS) return measured.ranking;
    const s = settings();
    const since = new Date(now - s.windowDays * DAY_MS).toISOString();
    const stats = measure(runsFrom(store.events.between(RUN_EVENTS, since)), { at: new Date(now).toISOString(), windowDays: s.windowDays });
    const previous = store.settings.getPriorityLaneChoice() ?? [];
    const r = rank({ stats, slots: slotsOf(machines), previous, settings: s });
    if (!same(previous, r.chosen)) {
      const by = changedBySettings ? 'settings' : r.by === 'manual' ? 'manual' : 'reliability';
      store.tx(() => {
        store.settings.setPriorityLaneChoice(r.chosen);
        store.events.append({ type: 'priority_lanes.changed', data: { from: previous, to: r.chosen, by } });
      });
    }
    changedBySettings = false;
    measured = { at: now, machines: key, ranking: r, measuredAt: nowIso(c) };
    return r;
  }

  return {
    settings,
    input(machines) {
      const s = settings();
      return { lanes: ranking(machines).chosen, highPriority: s.highPriority, whenIdle: s.whenIdle };
    },
    async view() {
      const machines = await c.machines.list();
      const r = ranking(machines);
      return { settings: settings(), defaults: DEFAULT_PRIORITY_LANE_SETTINGS, chosen: r.chosen, by: r.by, lanes: r.lanes, measuredAt: measured!.measuredAt, switchMargin: SWITCH_MARGIN };
    },
    async setSettings(patch) {
      const machines = await c.machines.list();
      const was = settings();
      const next = checked(patch, was, slotsOf(machines));
      store.tx(() => {
        store.settings.setPriorityLanes(next);
        if (JSON.stringify(was) !== JSON.stringify(next)) store.events.append({ type: 'priority_lanes.settings_changed', data: { from: was, to: next } });
      });
      changedBySettings = true;
      return next;
    },
  };
}
