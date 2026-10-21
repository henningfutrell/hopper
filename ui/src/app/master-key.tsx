// The master key (issue #659): the banner over every view while the key is not given at launch. A key the hopper made at
// its first start, or read from the old token key, is shown once to the hopper's admin, and the banner stays until they
// say they saved it; then it says to give it as HOPPER_MASTER_KEY at the next launch. A key a rotation made is shown in it
// the same way, once, from the rotation's answer. A hopper without its key does not start (issue #1296), so no banner
// says one is missing. Not dismissable: each state ends only by what it asks. The rotation itself is the hopper's
// admin's, on Vault (MasterKeyRotation); a key sealed to the host is rotated on the host. Banner and panel
// share one state.
import { KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { get, post } from '@/lib/api';
import type { MasterKeyRotated, MasterKeyView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

const VARIABLE = 'HOPPER_MASTER_KEY';
const ORIGIN: Partial<Record<MasterKeyView['source'], string>> = {
  generated: 'The hopper made it at its first start.',
  'old-token-key': 'The hopper read it from the old token key.',
  rotated: 'A rotation made it, and sealed every secret again under it. Give it before the next start: a start with the key it replaced is refused.',
};

export function MasterKeyBanner({ view, admin, revealed, onReveal, onSaved }: {
  view: MasterKeyView; admin: boolean; revealed?: string; onReveal(): void; onSaved(): void;
}) {
  if (view.source === 'given') return null;
  const copy = () => navigator.clipboard?.writeText(revealed ?? '').then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  const fingerprint = ` (fingerprint ${view.fingerprint})`;
  if (view.saved) {
    return (
      <div data-master-key="give" className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-1.5 text-sm">
        <KeyRound className="mr-2 inline size-4" />
        Give the master key{fingerprint} as {VARIABLE} at the next launch.{' '}
        <span className="text-muted-foreground">{view.source === 'generated'
          ? 'Without it, the next start is refused.'
          : view.source === 'rotated'
            ? 'A start with the key it replaced is refused.'
            : 'Until then the hopper reads it from the old token key.'}</span>
      </div>
    );
  }
  return (
    <div data-master-key="save" className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />Save the {view.source === 'rotated' ? 'new ' : ''}master key now{fingerprint}</p>
      <p className="text-xs text-muted-foreground">
        Every secret the hopper keeps is sealed under this key. {ORIGIN[view.source] ?? ''}
        {' '}Keep it in a password manager, then seal it to this host (bash master-key.sh seal) or give it as {VARIABLE} at each launch. Without it, a new container does not start.
        {' '}It is shown once, here, and never in the log.
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

/** The master key's state the banner and the rotation panel share: the view, and a key shown this once. */
interface Shared { view: MasterKeyView | null; revealed?: string }
let shared: Shared = { view: null };
const listeners = new Set<() => void>();
const setShared = (next: Shared): void => {
  shared = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useShared = (): Shared => useSyncExternalStore(subscribe, () => shared);

/** The banner, read from GET /api/master-key once the page is signed in. */
export function MasterKeyNotice() {
  const authed = useHopper((s) => s.authed);
  const admin = useCanAdminInstance();
  const { view, revealed } = useShared();
  useEffect(() => {
    if (!authed) return;
    get<MasterKeyView>('/api/master-key').then((v) => setShared({ ...shared, view: v }), () => setShared({ view: null }));
  }, [authed]);
  if (!view) return null;
  const act = (action: 'reveal' | 'saved') => post<MasterKeyView & { key?: string }>('/ui/api/master-key', { action }).then((r) => {
    const { key, ...next } = r;
    setShared({ view: next, ...(action === 'saved' ? {} : { revealed: key ?? shared.revealed }) });
  }, (e: Error) => toast.error(e.message));
  return <MasterKeyBanner view={view} admin={admin} revealed={revealed} onReveal={() => void act('reveal')} onSaved={() => void act('saved')} />;
}

/**
 * Rotate the master key (Vault), the hopper's admin's: after a confirm, a new key, every secret sealed again
 * under it in one transaction; the banner shows the new key once. A key the host sealed (issue #1296) is rotated on the
 * host, which seals the new key in the same step: the card says how, and offers no button.
 */
export function MasterKeyRotationCard({ view, admin, busy, onRotate }: { view: MasterKeyView | null; admin: boolean; busy: boolean; onRotate(): void }) {
  const confirmRotate = () => {
    if (window.confirm('Rotate the master key? Every secret the hopper keeps is sealed again under a new key, now. The new key is shown once, in the banner: save it, and give it as HOPPER_MASTER_KEY before the next start. A start with the old key is refused.')) onRotate();
  };
  return (
    <Panel title="Master key" icon={KeyRound} bodyClassName="space-y-2">
      <p data-master-key-rotation className="text-sm text-muted-foreground">
        Every secret the hopper keeps is sealed under the master key{view ? ` (fingerprint ${view.fingerprint})` : ''}. Rotate it when it may have been seen, or on a schedule: every secret is sealed again under a new key in one step, with no restart, and the old key opens none of them.
      </p>
      {view?.sealed
        ? <p data-master-key-sealed className="text-sm text-muted-foreground">The key is sealed to this host ({view.sealed}). Rotate it on the host, so the new key is sealed in the same step: <code className="font-mono text-xs">bash master-key.sh rotate</code>, in the folder of compose.yaml.</p>
        : admin
          ? <Button size="sm" variant="outline" disabled={busy || !view} onClick={confirmRotate}><RefreshCw className="size-4" />Rotate the master key</Button>
          : <p className="text-xs text-muted-foreground">Only the hopper's admin can rotate it.</p>}
    </Panel>
  );
}

export function MasterKeyRotation() {
  const admin = useCanAdminInstance();
  const { view } = useShared();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (shared.view === null) get<MasterKeyView>('/api/master-key').then((v) => setShared({ ...shared, view: v }), () => undefined);
  }, []);
  const rotate = () => {
    setBusy(true);
    post<MasterKeyRotated>('/ui/api/master-key', { action: 'rotate' }).then((r) => {
      const { key, resealed, unreadable, ...next } = r;
      setShared({ view: next, revealed: key });
      toast.success(`Rotated: ${resealed} secret(s) sealed again${unreadable ? `; ${unreadable} that did not open left as they were` : ''}. Save the new key from the banner now.`);
      window.scrollTo({ top: 0 });
    }, (e: Error) => toast.error(e.message)).finally(() => setBusy(false));
  };
  return <MasterKeyRotationCard view={view} admin={admin} busy={busy} onRotate={rotate} />;
}
