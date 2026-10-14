// Blast radius as people read it (issue #542): the gate's settings in one sentence, what a discovery changed, the tone
// of a level. Pure.
import { machineName } from './board.ts';
import type { BlastRadiusView, DiscoveryChanges, Job, MachineRadiusView, MachineView, RadiusLevel } from './wire.ts';

/** The start of every hold the gate gives (src/domain/blast-radius.ts GATE_HOLD; the UI imports nothing of src/ at run time). */
export const GATE_HOLD = 'held at the blast-radius gate';

/** A job a person may let through: waiting, and held at the gate. */
export const heldAtGate = (job: Pick<Job, 'status' | 'holdReason'>): boolean => job.status === 'held' && (job.holdReason ?? '').startsWith(GATE_HOLD);

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** One machine a gate hold names, and why the gate keeps it. */
export interface GateHeldOn { machineId: string; why: string }

/**
 * The machines a gate hold names (src/decider/gate.ts gateHold: `<GATE_HOLD>: <id> is <why>, …; only a job …`); none for
 * any other hold. An actor machine's purpose may hold commas: a part starts only where `<id> is an actor machine` or
 * `<id> is rated` does.
 */
export function gateHeldOn(holdReason: string): GateHeldOn[] {
  if (!holdReason.startsWith(`${GATE_HOLD}: `)) return [];
  const body = holdReason.slice(GATE_HOLD.length + 2).replace(/; only a job let through the gate runs there$/, '');
  return body.split(/, (?=\S+ is (?:an actor machine|rated ))/).flatMap((part) => {
    const m = /^(\S+) is (.+)$/.exec(part);
    return m ? [{ machineId: m[1]!, why: m[2]! }] : [];
  });
}

/** A gate hold in plain words (issue #883): why it waits, on which machines, and what letting it through does. */
export function gateHoldText(holdReason: string, machines: readonly Pick<MachineView, 'id' | 'label'>[]): string {
  const on = gateHeldOn(holdReason);
  if (on.length === 0) return holdReason;
  const name = (id: string) => machineName(id, machines);
  const why = on.map((m) => `${name(m.machineId)} is ${m.why.startsWith('rated ') ? `${m.why} blast radius` : m.why}`).join('; ');
  return `Held by the safety gate. The only machines that can run it take only jobs a person lets through: ${why}. `
    + `Let it through and it may run on ${list(on.map((m) => name(m.machineId)))}, with everything that machine can reach.`;
}

/** One sentence: which machines are gated, what passes, how often machines are discovered. */
export function summaryOf(v: BlastRadiusView): string {
  const s = v.settings;
  const passes = [
    ...(s.pass.labels.length ? [`with the label${s.pass.labels.length === 1 ? '' : 's'} ${s.pass.labels.join(', ')}`] : []),
    ...(s.pass.repos.length ? [`from ${s.pass.repos.join(', ')}`] : []),
    ...(s.pass.minPriority !== undefined ? [`of priority ${s.pass.minPriority} and above`] : []),
  ];
  const through = `jobs let through by a person${passes.length ? ` or ${list(passes)}` : ''}`;
  const gated = s.gateAt === 'off' ? `Only actor machines are gated: they take only ${through}.`
    : `Machines rated ${s.gateAt === 'high' ? 'high' : 'medium or high'}, and actor machines, take only ${through}.`;
  return `${gated} Discovered every ${s.everyMinutes} minutes.`;
}

/** What a discovery changed, in one line. */
export function changesText(c: DiscoveryChanges): string {
  if (c.first) return 'first discovery';
  const parts = [
    ...(c.level ? [`level ${c.level.from} → ${c.level.to}`] : []),
    ...(c.added.length ? [`added ${c.added.join(', ')}`] : []),
    ...(c.removed.length ? [`removed ${c.removed.join(', ')}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'nothing changed';
}

/** A machine's rating and what set it (issue #605): its reach, its template (a box), or both alike. */
export function radiusText(m: Pick<MachineRadiusView, 'radius' | 'template'>): string {
  if (!m.radius) return 'not discovered';
  const level = `${m.radius.level} radius`;
  if (!m.template) return level;
  const from = { reach: 'its reach', template: `template ${m.template.name}`, both: `its reach and template ${m.template.name}` }[m.radius.source];
  return `${level}, from ${from}`;
}

export const levelTone = (level: RadiusLevel | undefined): 'bad' | 'warn' | 'ok' | 'muted' =>
  (level === 'high' ? 'bad' : level === 'medium' ? 'warn' : level === 'low' ? 'ok' : 'muted');
