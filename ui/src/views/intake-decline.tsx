// Settings → Intake, Decline (issue #1710), an admin's: the choice the Decline confirm step offers first — close the issue as
// not planned, or leave it open without the hopper label —, for a request card and for a reopened card.
import { Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { DECLINE_CHOICES, DECLINE_EFFECT, DECLINE_LABEL } from '@/model/intake';
import type { IntakeDeclineDefaults } from '@/model/wire';
import { useHopper } from '@/store';
import { useDeclineDefaults } from '@/store/intake';

const CARDS: { kind: keyof IntakeDeclineDefaults; label: string }[] = [
  { kind: 'request', label: 'A request card' },
  { kind: 'reopened', label: 'A card of an issue reopened after its job was done' },
];

/** Read when shown; an answer without both choices is refused. */
export function IntakeDecline() {
  const [view, setView] = useState<IntakeDeclineDefaults | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<IntakeDeclineDefaults>('/api/intake-decline').then((v) => { if (v?.request && v?.reopened) setView(v); }, () => {});
  }, []);
  const save = async (next: IntakeDeclineDefaults) => {
    setBusy(true);
    try {
      const v = await post<IntakeDeclineDefaults>('/ui/api/intake-decline', next);
      setView(v); useDeclineDefaults.setState(v, true);
      toast.success('Decline default saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the decline default' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Intake: decline" icon={X} className="max-w-3xl">
      {view ? (
        <div data-slot="intake-decline" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />
            When you decline a card, you pick what happens to the issue on GitHub. This is the choice that shows first.</p>
          {CARDS.map(({ kind, label }) => (
            <fieldset key={kind} data-decline-default={kind} className="space-y-1">
              <legend className="font-medium">{label}</legend>
              {DECLINE_CHOICES.map((c) => (
                <label key={c} className="flex items-start gap-2">
                  <input type="radio" name={`decline-default-${kind}`} value={c} checked={view[kind] === c} disabled={busy} className="mt-1"
                    onChange={() => void save({ ...view, [kind]: c })} />
                  <span><span className="font-medium">{DECLINE_LABEL[c]}</span> <span className="text-muted-foreground">{DECLINE_EFFECT[c]}</span></span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
