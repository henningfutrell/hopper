// An account's limit on its problem card (issue #2897, design.md "Limit prompts"): who hit it, the prompt matched, when the
// account takes jobs again, and what the hopper did with the jobs.
import type { ProblemView } from '../model/wire';

export function ProblemLimit({ p, limit }: { p: ProblemView; limit: NonNullable<ProblemView['limit']> }) {
  const when = new Date(limit.resetsAt).toLocaleString();
  return (
    <div data-slot="limit" className="space-y-1 text-xs text-muted-foreground">
      <div>Account: {limit.account ?? `the one on ${p.scope.machineId ?? 'its machine'}`}{limit.laneId ? ` · lane ${limit.laneId}` : ''}</div>
      <div className="break-words">Prompt: <span className="font-mono">{limit.prompt}</span></div>
      {p.status === 'open' && <div>{limit.resetNamed ? `Takes jobs again at ${when}, the time the prompt names.` : `The prompt names no time: a job tries again at ${when}.`}</div>}
      {p.limitDid?.map((did) => <div key={did}>{did}</div>)}
    </div>
  );
}
