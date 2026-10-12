// A template's limits on its form (issue #708): the default and the max of a box's CPUs, memory (GiB) and time limit
// (minutes), and whether a box's home volume stays when the box goes. An empty pair is the hopper's default; a launch
// of the template may ask for anything up to the max (launch-params.tsx).
import { Input } from '@/components/ui/input';
import { Label } from '@/components/vault-fields';
import { DEFAULT_LIMITS, type LimitsDraft } from '@/model/sandbox-launch';

type Pair = 'cpus' | 'memoryGiB' | 'ttlMinutes';
const ROWS: { key: Pair; label: string; hint: string }[] = [
  { key: 'cpus', label: 'CPUs', hint: `empty: ${DEFAULT_LIMITS.cpus.default}, at most ${DEFAULT_LIMITS.cpus.max}` },
  { key: 'memoryGiB', label: 'Memory in GiB', hint: `empty: ${DEFAULT_LIMITS.memoryMb.default / 1024}, at most ${DEFAULT_LIMITS.memoryMb.max / 1024}` },
  { key: 'ttlMinutes', label: 'Time limit', hint: 'minutes; empty: no time limit, or no max' },
];

export function LimitsInput({ draft, busy, problem, onChange }: { draft: LimitsDraft; busy: boolean; problem: string | undefined; onChange: (d: LimitsDraft) => void }) {
  const set = (key: Pair, end: 'default' | 'max', v: string) => onChange({ ...draft, [key]: { ...draft[key], [end]: v } });
  return (
    <div className="space-y-1"><Label>Limits — what a box of it gets by default, and the most a launch may ask for</Label>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        {ROWS.map((r) => (
          <div key={r.key} className="space-y-1">
            <div className="text-muted-foreground">{r.label} <span className="opacity-70">({r.hint})</span></div>
            <div className="flex gap-1.5">
              {(['default', 'max'] as const).map((end) => (
                <Input key={end} aria-label={`${r.label} ${end}`} placeholder={end} inputMode="decimal" className="h-8 w-full font-mono text-xs" disabled={busy}
                  value={draft[r.key][end]} onChange={(e) => set(r.key, end, e.target.value)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <label className="flex min-h-8 items-center gap-2 text-xs">
        <input type="checkbox" aria-label="Keep the home volume when a box goes" checked={draft.keepHome} disabled={busy} onChange={(e) => onChange({ ...draft, keepHome: e.target.checked })} />
        Keep the home volume (the agent&apos;s sign-in) when a box goes
      </label>
      {problem && <p className="text-xs text-destructive" role="alert" data-limits-problem>{problem}</p>}
    </div>
  );
}
