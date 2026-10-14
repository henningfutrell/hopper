// Settings → Artifacts (issue #624), an admin's: the most one artifact may hold and all of the user's together, how
// many days they are kept, and public links — whether they work at all (off: every one stops at once) and for how long;
// the link base, where the links a job reports point (issue #673).
// Saved to the daemon; applies to the next put and the next load, without a restart.
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { ArtifactSettings as Settings } from '@/model/wire';
import { refreshArtifacts, saveArtifactSettings, useArtifacts } from '@/store/artifacts';

const MB = 1024 * 1024;

function Form({ s }: { s: Settings }) {
  const [draft, setDraft] = useState({
    maxMb: String(Math.round((s.maxBytes / MB) * 10) / 10), userMb: String(Math.round(s.userBytes / MB)), retentionDays: String(s.retentionDays),
    publicLinks: s.publicLinks, linkHours: String(s.linkHours), linkHoursMax: String(s.linkHoursMax), linkBase: s.linkBase,
  });
  const [busy, setBusy] = useState(false);
  const num = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value.replace(/[^\d.]/g, '') });
  const save = async () => {
    setBusy(true);
    await saveArtifactSettings({
      maxBytes: Math.round(Number(draft.maxMb) * MB), userBytes: Math.round(Number(draft.userMb) * MB), retentionDays: Number(draft.retentionDays),
      publicLinks: draft.publicLinks, linkHours: Number(draft.linkHours), linkHoursMax: Number(draft.linkHoursMax), linkBase: draft.linkBase.trim(),
    });
    setBusy(false);
  };
  const field = (label: string, k: keyof typeof draft, unit: string) => (
    <label className="flex items-center gap-2">
      <span className="w-56 text-muted-foreground">{label}</span>
      <Input className="h-8 w-28" value={String(draft[k])} onChange={num(k)} aria-label={label} disabled={busy} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </label>
  );
  return (
    <div data-slot="artifact-settings" className="space-y-2 text-sm">
      {field('One artifact, at most', 'maxMb', 'MB')}
      {field('All of this user\'s, at most', 'userMb', 'MB')}
      {field('Kept for', 'retentionDays', 'days')}
      <label className="flex items-center gap-2">
        <Switch checked={draft.publicLinks} disabled={busy} aria-label="Public links work" onCheckedChange={(publicLinks) => setDraft({ ...draft, publicLinks })} />
        Public links work. Off: every public link stops at once, and no new one is made.
      </label>
      {field('A public link works for', 'linkHours', 'hours, unless its maker says')}
      {field('A public link works at most', 'linkHoursMax', 'hours')}
      <label className="flex flex-wrap items-center gap-2">
        <span className="w-56 text-muted-foreground">Link base</span>
        <Input className="h-8 w-72" value={draft.linkBase} placeholder="http://192.168.1.10:4790" aria-label="Link base" disabled={busy}
          onChange={(e) => setDraft({ ...draft, linkBase: e.target.value })} />
        <span className="basis-full text-xs text-muted-foreground">
          Where the links a job reports, and a notification's, point: an address this hopper answers to. Empty: its public URL, else a LAN name that is an IP or ends in .local. In the UI, links use the address you opened it at.
        </span>
      </label>
      <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
    </div>
  );
}

export function ArtifactSettings() {
  const view = useArtifacts((s) => s.view);
  useEffect(() => { void refreshArtifacts(); }, []);
  return (
    <Panel title="Artifacts" icon={FolderOpen} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.settings)} s={view.settings} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
