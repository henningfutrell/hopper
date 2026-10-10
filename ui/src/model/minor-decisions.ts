// Decider calls in plain words (issue #550): the agreement rate, a Jev pick — the option, how sure, what became of
// it —, what was decided after it, the mode names, and a pick event's line; the TypeSafe API key's state and the note
// on a variable it was imported from (issue #657). Pure.
import type { MinorDecisionMode, MinorDecisionOption, MinorDecisionPickView, TypesafeKeyView } from './wire.ts';

/** A pick as these read it: its identity and place aside. */
type Pick = Omit<MinorDecisionPickView, 'pickId' | 'at' | 'point' | 'jobId' | 'questionId'>;

export const MODE_TEXT: Readonly<Record<MinorDecisionMode, string>> = {
  off: 'Off', shadow: 'Shadow: record only', active: 'Active: Jev decides when sure',
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
export const rate = (x: number | null): string => (x === null ? '—' : pct(x));

/** An option by its label and id; a value no option has (a typed answer) as it is. */
export function optionText(options: readonly MinorDecisionOption[], id: string): string {
  const o = options.find((x) => x.id === id);
  return o ? `${o.label} (${o.id})` : id;
}

function fate(p: Pick): string {
  if (p.applied) return 'applied';
  switch (p.notApplied) {
    case 'shadow': return 'recorded only';
    case 'below_threshold': return `below the ${pct(p.threshold)} needed`;
    case 'consequential': return `consequential${p.consequential?.length ? ` (${p.consequential.join(', ')})` : ''}: never decided by Jev`;
    default: return 'not applied';
  }
}

export function pickSummary(p: Pick): string {
  if (p.pick === undefined) return `no pick${p.error ? `: ${p.error}` : ''}`;
  return `${optionText(p.options, p.pick)} at ${pct(p.confidence ?? 0)} — ${fate(p)}`;
}

/** What was decided after the pick; empty while it is not known. */
export function pickDecided(p: Pick): string {
  if (p.actual === undefined) return '';
  if (p.overridden) return `overridden: ${optionText(p.options, p.actual)}`;
  return `${p.decidedBy ?? 'later'} decided ${optionText(p.options, p.actual)}: ${p.agreed ? 'agreed' : 'differed'}`;
}

/** A `minor_decision.picked` event's data as one line. */
export function pickedEventDetail(d: Record<string, unknown>): string {
  return `Jev: ${pickSummary(d as unknown as Pick)}`;
}

/** The TypeSafe API key's state (issue #657): set or not, its last 4 characters, when and by whom. Never more of the key. */
export function keyStatus(k: TypesafeKeyView): string {
  if (!k.set) return 'Not set';
  const parts = ['Set'];
  if (k.last4) parts.push(`ends in ${k.last4}`);
  if (k.setAt) parts.push(`set ${k.setAt.slice(0, 16).replace('T', ' ')} UTC${k.setBy ? ` by ${k.setBy}` : ''}`);
  return parts.join(' — ');
}

/** The note while the runtime still gives the variable the key was imported from: the hopper does not read it. */
export function environmentNote(k: TypesafeKeyView): string | undefined {
  if (!k.environment) return undefined;
  return `${k.environment.variable} is still set. The key was imported from it once; the hopper does not read it now. Remove it from the environment.`;
}
