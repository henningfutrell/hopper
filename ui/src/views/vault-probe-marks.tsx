// A template's probe marks on Vault (issue #916, design.md "The read-only check"): for a template that takes
// the read-only check, each read probe its last check ran can be marked. `expect-denied`: the read must be refused, as a
// credential that is right refuses it (helm list on a view role). `skip`: the check does not run it. A write probe takes
// no mark: each write must be refused, always. A save runs the check again.
import { Label } from '@/components/vault-fields';
import { FIELD } from '@/components/plugin-form';
import { markableProbes, PROBE_MARK_CHOICES } from '@/model/vault';
import type { TemplateView } from '@/model/wire';

export function ProbeMarksInput({ t, marks, busy, onChange }: { t: TemplateView; marks: Record<string, string>; busy: boolean; onChange: (m: Record<string, string>) => void }) {
  const probes = markableProbes(t, marks);
  return (
    <div className="space-y-1"><Label>Read probes of the read-only check — mark a read that a correct credential refuses</Label>
      {probes.length === 0 ? <div className="text-xs text-muted-foreground">The check has not run yet: its read probes show here after it runs.</div> : (
        <ul className="space-y-1" aria-label="Probe marks">
          {probes.map((id) => (
            <li key={id} className="flex flex-wrap items-center gap-2">
              <span className="w-40 font-mono text-xs">{id}</span>
              <select aria-label={`Mark for ${id}`} className={`${FIELD} w-56`} value={marks[id] ?? ''} disabled={busy} onChange={(e) => {
                const { [id]: _was, ...rest } = marks;
                onChange(e.target.value ? { ...rest, [id]: e.target.value } : rest);
              }}>
                {PROBE_MARK_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
