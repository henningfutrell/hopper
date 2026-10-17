// Settings → Version → This hopper (issue #465), the hopper's admin's: the instance id, made once and kept in the database,
// and the display name the admin calls this hopper (GET /api/display-name, POST /ui/api/display-name). Only the admin
// reads them: for anyone else the panel is not shown.
import { Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { useHopper } from '@/store';

type DisplayNameView = { instanceId: string; displayName: string };

function Form({ view, onSaved }: { view: DisplayNameView; onSaved: (v: DisplayNameView) => void }) {
  const [draft, setDraft] = useState(view.displayName);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<DisplayNameView>('/ui/api/display-name', { displayName: draft.trim() }));
      toast.success('Display name saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the display name' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="display-name" className="space-y-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="w-32 text-muted-foreground">Display name</span>
        <Input className="h-8 w-64" value={draft} maxLength={80} placeholder="No name" aria-label="Display name" disabled={busy}
          onChange={(e) => setDraft(e.target.value)} />
        <Button size="sm" disabled={busy || draft.trim() === view.displayName} onClick={() => void save()}>Save</Button>
      </label>
      <p className="flex flex-wrap items-center gap-2">
        <span className="w-32 text-muted-foreground">Instance id</span>
        <code data-slot="instance-id" className="font-mono text-xs">{view.instanceId}</code>
      </p>
      <p className="text-xs text-muted-foreground">
        The instance id identifies this hopper. The hopper makes it once and keeps it in its database, so it stays the same after a restart or an update.
        The display name is what you call this hopper. Empty: no name.
      </p>
    </div>
  );
}

export function DisplayName() {
  const [view, setView] = useState<DisplayNameView | undefined>();
  useEffect(() => { void get<DisplayNameView>('/api/display-name').then((v) => { if (typeof v?.instanceId === 'string') setView(v); }, () => {}); }, []);
  if (!view) return null;
  return (
    <Panel title="This hopper" icon={Server} className="max-w-xl">
      <Form key={view.displayName} view={view} onSaved={setView} />
    </Panel>
  );
}
