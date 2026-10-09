// Blast radius as people read it (issue #542): the gate's settings in one sentence, what a discovery changed, the tone
// of a level. Pure.
import type { BlastRadiusView, DiscoveryChanges, Job, RadiusLevel } from './wire.ts';

/** The start of every hold the gate gives (src/domain/blast-radius.ts GATE_HOLD; the UI imports nothing of src/ at run time). */
export const GATE_HOLD = 'held at the blast-radius gate';

/** A job a person may let through: waiting, and held at the gate. */
export const heldAtGate = (job: Pick<Job, 'status' | 'holdReason'>): boolean => job.status === 'held' && (job.holdReason ?? '').startsWith(GATE_HOLD);

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

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

export const levelTone = (level: RadiusLevel | undefined): 'bad' | 'warn' | 'ok' | 'muted' =>
  (level === 'high' ? 'bad' : level === 'medium' ? 'warn' : level === 'low' ? 'ok' : 'muted');
