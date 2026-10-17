// The sandbox playground on Machines (issue #1410, design.md "The sandbox playground"): the create form's draft, checked
// against the hopper's limits before it is sent, and how a sandbox's state reads. Pure.
import type { PlaygroundLimits, PlaygroundSandbox } from '../../../src/domain/types.ts';

/** The form as typed: each field a string; empty takes the default. */
export interface PlaygroundDraft { count: string; agent: string; template: string; cpus: string; memoryMb: string; ttlMinutes: string }

export const EMPTY_DRAFT: PlaygroundDraft = { count: '1', agent: '', template: '', cpus: '', memoryMb: '', ttlMinutes: '' };

export interface PlaygroundBody { count: number; agent?: string; template?: string; cpus?: number; memoryMb?: number; ttlMinutes?: number }

/**
 * What POST /ui/api/sandbox-playground is sent for the draft, or why not. The hopper checks the template's limits. A
 * template names its own image, so the agent is sent only with no template; none: the hopper's default agent.
 */
export function playgroundBody(d: PlaygroundDraft, l: PlaygroundLimits): PlaygroundBody | string {
  const count = Number(d.count.trim());
  if (!Number.isInteger(count) || count < 1) return 'How many: a whole number, 1 or more';
  const body: PlaygroundBody = { count, ...(d.template ? { template: d.template } : d.agent ? { agent: d.agent } : {}) };
  const fields = [['cpus', 'CPUs', false], ['memoryMb', 'Memory (MiB)', true], ['ttlMinutes', 'Time limit (minutes)', true]] as const;
  for (const [k, label, whole] of fields) {
    const t = d[k].trim();
    if (t === '') continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) return `${label}: ${whole ? 'a whole number' : 'a number'} above 0`;
    if (n > l.max[k]) return `${label}: at most ${l.max[k]}`;
    body[k] = n;
  }
  return body;
}

/** How a sandbox's state reads in its row. */
export function playgroundStateText(s: PlaygroundSandbox, now: Date): string {
  switch (s.state) {
    case 'starting': return 'starting';
    case 'failed': return `did not start${s.problem ? `: ${s.problem}` : ''}`;
    case 'destroying': return `being destroyed${s.problem ? `: ${s.problem}` : ''}`;
    case 'running': {
      const left = Math.max(0, Math.round((Date.parse(s.expiresAt) - now.getTime()) / 60_000));
      return `running, ${left} min left`;
    }
  }
}
