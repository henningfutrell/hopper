// A template's tools on Vault (issue #716, design.md "Tools assembled per run"): the tools the hopper adds to
// its image, each pinned and checked. One button per tool; a change waits for approval, as a new image does.
import { Label } from '@/components/vault-fields';
import { BOX_TOOLS } from '@/model/vault';

export function ToolsInput({ tools, busy, onChange }: { tools: string[]; busy: boolean; onChange: (t: string[]) => void }) {
  return (
    <div className="space-y-1"><Label>Tools the hopper adds to its image — each pinned and checked</Label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tools">
        {BOX_TOOLS.map((x) => {
          const on = tools.includes(x);
          return <button key={x} type="button" aria-pressed={on} disabled={busy} onClick={() => onChange(on ? tools.filter((y) => y !== x) : [...tools, x])}
            className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{x}</button>;
        })}
      </div>
    </div>
  );
}
