// A sandbox box's launch parameters on Add machine (issue #708): its CPUs, memory (GiB) and time limit (minutes),
// which of its template's secrets and tools it gets, and one of the template's operation profiles. The form starts at
// the template's defaults (the hopper's for a box of no template), says the max of each, and shows why a value is not
// allowed before Start: the server checks it again. A box the hopper does not start (the line) takes only its CPUs and
// memory (`limitsOnly`): it has no record, so no time limit, secrets, profile or tools are given to it.
import { Input } from '@/components/ui/input';
import { launchRanges, profileKey, type LaunchDraft } from '@/model/sandbox-launch';
import { BOX_TOOLS, profileText } from '@/model/vault';
import type { TemplateView } from '@/model/wire';

function Toggles({ label, all, on, busy, onChange }: { label: string; all: readonly string[]; on: string[]; busy: boolean; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {all.map((x) => {
        const pressed = on.includes(x);
        return <button key={x} type="button" aria-pressed={pressed} disabled={busy} onClick={() => onChange(pressed ? on.filter((y) => y !== x) : [...on, x])}
          className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors ${pressed ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{x}</button>;
      })}
    </div>
  );
}

export function LaunchParamsInput({ template: t, draft, busy, problem, onChange, limitsOnly = false }: {
  template: TemplateView | null; draft: LaunchDraft; busy: boolean; problem: string | undefined; onChange: (d: LaunchDraft) => void; limitsOnly?: boolean;
}) {
  const r = launchRanges(t ?? undefined);
  const ttlMax = r.ttlMinutes.max === undefined ? 'empty: no time limit' : `at most ${r.ttlMinutes.max}${r.ttlMinutes.default === undefined ? '; empty: none' : ''}`;
  const numbers: { key: 'cpus' | 'memoryGiB' | 'ttlMinutes'; label: string; hint: string }[] = [
    { key: 'cpus', label: 'CPUs', hint: `at most ${r.cpus.max}` },
    { key: 'memoryGiB', label: 'Memory in GiB', hint: `at most ${Math.round((r.memoryMb.max / 1024) * 1000) / 1000}` },
    ...(limitsOnly ? [] : [{ key: 'ttlMinutes' as const, label: 'Time limit in minutes', hint: ttlMax }]),
  ];
  const tools = limitsOnly ? [] : t ? t.tools ?? [] : BOX_TOOLS;
  const scoped = t && !limitsOnly ? t : null;
  return (
    <div className="grid gap-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-3">
        {numbers.map((n) => (
          <label key={n.key} className="grid gap-1">
            <span className="text-muted-foreground">{n.label} <span className="opacity-70">({n.hint})</span></span>
            <Input aria-label={n.label} inputMode="decimal" className="h-9 font-mono text-sm" disabled={busy} value={draft[n.key]} onChange={(e) => onChange({ ...draft, [n.key]: e.target.value })} />
          </label>
        ))}
      </div>
      {scoped && scoped.gives.length > 0 && (
        <div className="grid gap-1"><span className="text-muted-foreground">Secrets it may ask for — of what the template gives now</span>
          <Toggles label="Secrets for this box" all={scoped.gives} on={draft.secrets} busy={busy} onChange={(secrets) => onChange({ ...draft, secrets })} /></div>
      )}
      {scoped && scoped.profiles.length > 0 && (
        <div className="grid gap-1"><span className="text-muted-foreground">Operation profile — its jobs mint credentials for this one only</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Operation profile">
            {[null, ...scoped.profiles.map(profileKey)].map((k) => {
              const p = scoped.profiles.find((x) => profileKey(x) === k);
              return <button key={k ?? 'none'} type="button" aria-pressed={draft.profile === k} disabled={busy} onClick={() => onChange({ ...draft, profile: k })}
                className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors ${draft.profile === k ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{p ? profileText(p) : 'none'}</button>;
            })}
          </div></div>
      )}
      {tools.length > 0 && (
        <div className="grid gap-1"><span className="text-muted-foreground">Tools added to its image{t ? ' — of the template\'s' : ''}</span>
          <Toggles label="Tools for this box" all={tools} on={draft.tools} busy={busy} onChange={(x) => onChange({ ...draft, tools: x })} /></div>
      )}
      {problem && <p className="text-destructive" role="alert" data-launch-problem>{problem}</p>}
    </div>
  );
}
