// The master key (issue #659): the banner over every view while the key is not given at launch. A key the hopper made at
// its first start, or read from the old token key, is shown once to the hopper's admin, and the banner stays until they
// say they saved it; then it says to give it as HOPPER_MASTER_KEY at the next launch. A limited hopper — secrets kept, no
// key given — says which key is missing and how to give it. Not dismissable: each state ends only by what it asks.
import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { get, post } from '@/lib/api';
import type { MasterKeyView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

const VARIABLE = 'HOPPER_MASTER_KEY';

export function MasterKeyBanner({ view, admin, revealed, onReveal, onSaved }: {
  view: MasterKeyView; admin: boolean; revealed?: string; onReveal(): void; onSaved(): void;
}) {
  if (view.source === 'given') return null;
  const copy = () => navigator.clipboard?.writeText(revealed ?? '').then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  if (view.source === 'missing') {
    return (
      <div data-master-key="missing" className="rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
        <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />Limited: the master key is missing</p>
        <p className="mt-1 break-words">{view.problem}</p>
        <p className="mt-1 text-xs text-muted-foreground">Nothing is deleted. What needs a secret stays off until the key is given. Do not connect GitHub again: give the key.</p>
      </div>
    );
  }
  const fingerprint = view.fingerprint ? ` (fingerprint ${view.fingerprint})` : '';
  if (view.saved) {
    return (
      <div data-master-key="give" className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-1.5 text-sm">
        <KeyRound className="mr-2 inline size-4" />
        Give the master key{fingerprint} as {VARIABLE} at the next launch.{' '}
        <span className="text-muted-foreground">{view.source === 'generated'
          ? 'Without it, the next start is limited.'
          : 'Until then the hopper reads it from the old token key.'}</span>
      </div>
    );
  }
  return (
    <div data-master-key="save" className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />Save the master key now{fingerprint}</p>
      <p className="text-xs text-muted-foreground">
        Every secret the hopper keeps is sealed under this key. {view.source === 'generated' ? 'The hopper made it at its first start.' : 'The hopper read it from the old token key.'}
        {' '}Keep it in a password manager, then give it as {VARIABLE} at each launch. Without it, a new container opens none of the secrets.
        {' '}It is shown once here, and once in the start log.
      </p>
      {revealed !== undefined && (
        <div className="flex items-start gap-2">
          <pre data-master-key-value className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-[11px]">{revealed}</pre>
          <Button variant="outline" size="xs" onClick={() => void copy()}>Copy</Button>
        </div>
      )}
      {admin ? (
        <div className="flex flex-wrap gap-2">
          {view.revealable && <Button size="xs" variant="outline" onClick={onReveal}>Show the key (once)</Button>}
          <Button size="xs" onClick={onSaved}>I saved it</Button>
        </div>
      ) : <p className="text-xs text-muted-foreground">Only the hopper's admin can see the key and say it is saved.</p>}
    </div>
  );
}

/** The banner, read from GET /api/master-key once the page is signed in. */
export function MasterKeyNotice() {
  const authed = useHopper((s) => s.authed);
  const admin = useCanAdminInstance();
  const [view, setView] = useState<MasterKeyView | null>(null);
  const [revealed, setRevealed] = useState<string | undefined>();
  useEffect(() => {
    if (!authed) return;
    get<MasterKeyView>('/api/master-key').then(setView, () => setView(null));
  }, [authed]);
  if (!view) return null;
  const act = (action: 'reveal' | 'saved') => post<MasterKeyView & { key?: string }>('/ui/api/master-key', { action }).then((r) => {
    const { key, ...next } = r;
    if (key !== undefined) setRevealed(key);
    if (action === 'saved') setRevealed(undefined);
    setView(next);
  }, (e: Error) => toast.error(e.message));
  return <MasterKeyBanner view={view} admin={admin} revealed={revealed} onReveal={() => void act('reveal')} onSaved={() => void act('saved')} />;
}
