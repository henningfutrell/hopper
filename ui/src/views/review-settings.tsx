// Below a review section's cards (issues #537, #543): the earlier ones — decided or cancelled, a compact list, with who
// signed each off and when — and, for an admin, the section's settings: which escalation levels review (only the ones
// the server names), who may sign off, and how often the levels may send one back. Keyed by the saved values, so a
// save starts the form from them again.
import { History, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { InlineMarkdown } from '@/components/markdown';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIELD } from '@/components/plugin-form';
import { clock } from '@/model/format';
import { firstLine } from '@/model/questions';
import { headlineOf, REVIEW_UI } from '@/model/reviews';
import type { ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettingsView, ReviewSignOffBy } from '@/model/wire';
import { saveReviewSettings } from '@/store/reviews';
import { FollowOns } from './proposal-paths';

const TONE: Record<string, 'ok' | 'bad' | 'muted'> = { accepted: 'ok', rejected: 'bad' };

export function ReviewHistory({ kind, items, type }: { kind: ReviewKind; items: ReviewItemView[]; type: ReviewSectionView | null }) {
  return (
    <Panel title={`Earlier ${REVIEW_UI[kind].noun}s`} icon={History} count={items.length} list>
      <ul data-slot="review-history" data-section={REVIEW_UI[kind].section} className="divide-y text-sm">
        {items.map((p) => (
          <li key={p.id} data-earlier-item={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
            <InlineMarkdown text={firstLine(headlineOf(p, type) ?? p.jobId.slice(0, 8))} className="min-w-0 truncate" />
            <StatusBadge status={p.status} tone={TONE[p.status] ?? 'muted'} />
            {p.signOff && <span className="text-xs text-muted-foreground">version {p.signOff.version} · by {p.signOff.by ?? p.signOff.stage}</span>}
            <span className="num ml-auto text-xs text-muted-foreground">{clock(p.signOff?.at ?? p.updatedAt)}</span>
            {/* A proposal's selected paths and their follow-ons (issue #651). */}
            {kind === 'proposal' && <FollowOns p={p} />}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SettingsForm({ kind, settings }: { kind: ReviewKind; settings: ReviewSettingsView }) {
  const ui = REVIEW_UI[kind];
  const [reviewers, setReviewers] = useState<string[]>(settings.reviewers.filter((r) => settings.levels.includes(r)));
  const [signOff, setSignOff] = useState<ReviewSignOffBy>(settings.signOff);
  const [levelRevisions, setLevelRevisions] = useState(String(settings.levelRevisions));
  const [busy, setBusy] = useState(false);
  // Lowest first, in the escalation levels' order.
  const toggle = (name: string) => setReviewers((r) => settings.levels.filter((l) => (l === name ? !r.includes(l) : r.includes(l))));
  const save = async () => {
    setBusy(true);
    await saveReviewSettings(kind, { reviewers, signOff, levelRevisions: Number(levelRevisions) });
    setBusy(false);
  };
  return (
    <div data-slot="review-settings" data-section={ui.section} className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        A {ui.noun} goes through the reviewer levels, lowest first, then to a person. {settings.reviewers.length === 0 ? 'No level reviews now: a person does.' : `Now: ${settings.reviewers.join(' → ')} → a person.`}
      </p>
      <fieldset className="grid gap-1">
        <legend className="text-xs text-muted-foreground">Reviewer levels (the escalation levels)</legend>
        {settings.levels.length === 0 && <span className="text-muted-foreground">No escalation levels are set up: add one in Settings → Question gates.</span>}
        {settings.levels.map((l) => (
          <label key={l} className="flex items-center gap-2">
            <input type="checkbox" name={l} checked={reviewers.includes(l)} disabled={busy} onChange={() => toggle(l)} />
            <span className="font-mono">{l}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Who may accept</span>
          <select className={`${FIELD} h-8 w-64 text-sm`} aria-label={`Who may accept a ${ui.noun}`} value={signOff} disabled={busy} onChange={(e) => setSignOff(e.target.value as ReviewSignOffBy)}>
            <option value="owner">only a person</option>
            <option value="top-level">the top reviewer level too</option>
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Times the levels may send one back</span>
          <Input type="number" min="0" max="5" step="1" className="h-8 w-28" aria-label={`Times the reviewer levels may send one ${ui.noun} back`} value={levelRevisions} disabled={busy} onChange={(e) => setLevelRevisions(e.target.value)} /></label>
        <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

export function ReviewSettingsPanel({ kind, settings }: { kind: ReviewKind; settings: ReviewSettingsView }) {
  return (
    <Panel title={`${REVIEW_UI[kind].label} settings`} icon={Settings2}>
      <SettingsForm key={`${settings.reviewers.join(',')}:${settings.signOff}:${settings.levelRevisions}:${settings.levels.join(',')}`} kind={kind} settings={settings} />
    </Panel>
  );
}
