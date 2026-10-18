// Skill rules (issue #1924 part 5, design.md "Conditional skills"): on the Skills page, the rules that give a job a library
// skill beside its work skill when it matches — its repository, a label of its item, its kind of work, the files its change
// touches. A person adds a rule, edits one in its place, or removes one; each save sends every rule (POST
// /ui/api/work-skills `rules`, in place of the ones before) and answers the new view. The next job gets the change.
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { emptyRuleDraft, KIND_LABEL, ruleDraftOf, ruleDraftProblem, ruleOfDraft, ruleRows, type RuleDraft } from '@/model/skills';
import { useCanAdmin } from '@/store/selectors';
import type { SkillRule } from '../../../src/domain/conditional-skills.ts';
import type { SkillLibraryView } from '../../../src/domain/skill-library.ts';
import { changeLibrary } from './skill-library';

/** Edits one rule, a new one or one in the list; the save hands back the rule as the daemon keeps it. */
function RuleEditor({ view, draft: from, busy, onSave, onCancel }: {
  view: SkillLibraryView; draft: RuleDraft; busy: boolean; onSave: (rule: SkillRule) => void; onCancel: () => void;
}) {
  const [d, setD] = useState(from);
  const problem = ruleDraftProblem(view, d);
  const text = (key: 'repos' | 'labels' | 'paths', label: string, placeholder: string) => (
    <label className="space-y-1 text-xs">
      <span className="font-medium">{label}</span>
      <Input name={`rule-${key}`} className="font-mono text-xs" value={d[key]} placeholder={placeholder} disabled={busy}
        onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </label>
  );
  return (
    <div data-slot="skill-rule-editor" className="space-y-2 rounded-md border p-3">
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Skill</span>
        <select name="rule-skill" aria-label="Skill" className={FIELD} value={d.skill} disabled={busy} onChange={(e) => setD({ ...d, skill: e.target.value })}>
          {view.skills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">A job gets the skill when each condition you fill in matches: one of its words each. Separate words with commas.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {text('repos', 'Repositories', 'owner/name')}
        {text('labels', 'Labels', 'iac, gitops')}
        {text('paths', 'Files the change touches', '*.tf, src/**')}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="font-medium">Kinds of work</span>
        {view.kinds.map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" name={`rule-kind-${k}`} checked={d.kinds.includes(k)} disabled={busy}
              onChange={(e) => setD({ ...d, kinds: e.target.checked ? [...d.kinds, k] : d.kinds.filter((x) => x !== k) })} />
            {KIND_LABEL[k]}
          </label>
        ))}
      </div>
      {problem && <div className="text-xs text-destructive">{problem}</div>}
      <div className="flex gap-1">
        <Button size="sm" disabled={busy || problem !== undefined} onClick={() => onSave(ruleOfDraft(d))}>Save rule</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function SkillRules({ view, onChange }: { view: SkillLibraryView; onChange: (v: SkillLibraryView) => void }) {
  const authed = useCanAdmin();
  const [busy, setBusy] = useState(false);
  // The rule being edited: its place in the list, 'new' for one at the end, null for none.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const rules = view.workSkills.rules ?? [];
  const save = async (next: SkillRule[], said: string) => {
    setBusy(true);
    const ok = await changeLibrary('/ui/api/work-skills', { rules: next }, onChange, said);
    setBusy(false);
    if (ok) setEditing(null);
  };
  const rows = ruleRows(view);
  return (
    <Panel title="Skill rules" icon={Wand2} count={rows.length} bodyClassName="space-y-2">
      <div data-slot="skill-rules" className="space-y-2">
        <p className="text-xs text-muted-foreground">A rule gives a job a skill beside its work skill when the job matches it. A skill with done criteria is checked by the hopper before the job ends done.</p>
        {rows.length === 0 && editing !== 'new' && <div className="text-xs text-muted-foreground">No skill rule.</div>}
        {rows.map((r) => (editing === r.index
          ? <RuleEditor key={r.index} view={view} draft={ruleDraftOf(rules[r.index]!)} busy={busy}
              onSave={(rule) => void save(rules.map((x, i) => (i === r.index ? rule : x)), 'Skill rule saved; the next job gets it')} onCancel={() => setEditing(null)} />
          : (
            <div key={r.index} data-slot="skill-rule" className="flex items-center gap-2 text-xs">
              <span className="font-mono font-medium">{r.skill}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.line}>{r.line}</span>
              {authed && (
                <>
                  <Button size="sm" variant="ghost" disabled={busy || editing !== null} onClick={() => setEditing(r.index)}><Pencil /> Edit</Button>
                  <Button size="sm" variant="ghost" disabled={busy || editing !== null}
                    onClick={() => void save(rules.filter((_, i) => i !== r.index), 'Skill rule removed; the next job does not get it')}><Trash2 /> Remove</Button>
                </>
              )}
            </div>
          )))}
        {editing === 'new' && (
          <RuleEditor view={view} draft={emptyRuleDraft(view)} busy={busy}
            onSave={(rule) => void save([...rules, rule], 'Skill rule added; the next job gets it')} onCancel={() => setEditing(null)} />
        )}
        {authed && editing === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing('new')}><Plus /> Add a rule</Button>}
      </div>
    </Panel>
  );
}
