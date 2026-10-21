// Vault, the read policy (issue #716): the assets the hopper approves read on with no person, for a template a
// job asks for (`sh "$HOPPER_SKILL" sandbox-template --needs …`). Each entry is an asset as Access names it
// (`cluster/lab`) or one that ends in `*` (`aws-account/*`). Write, sync and apply always wait for a person. Every user
// sees the policy; only an admin edits it.
import { Pencil, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { Label } from '@/components/vault-fields';
import { post, SessionRejected } from '@/lib/api';
import { readPolicyEntries, readPolicyText } from '@/model/vault-read-policy';
import type { VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

export function ReadPolicy({ entries, onView }: { entries: string[]; onView: (v: VaultView) => void }) {
  const can = useCanAdmin();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      onView(await post<VaultView>('/ui/api/vault', { action: 'set-read-policy', assets: readPolicyEntries(draft ?? '') }));
      toast.success('Read policy saved');
      setDraft(null);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Read policy" icon={ShieldCheck} count={entries.length || ''} bodyClassName="space-y-3"
      action={can && draft === null ? <Button size="sm" variant="outline" onClick={() => setDraft(entries.join('\n'))} disabled={busy}><Pencil />Edit</Button> : undefined}>
      <p className="text-sm text-muted-foreground">A job can ask the hopper for the template its work needs. When every need is a read on an asset this policy holds, the hopper approves the new template itself. {readPolicyText(entries)}</p>
      {draft !== null ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="block space-y-1"><Label>One entry per line — an asset (cluster/lab), or every asset whose name starts so (aws-account/*)</Label>
            <Textarea className="font-mono text-sm" rows={5} value={draft} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder={'cluster/lab\nnamespace/lab/*\naws-account/123456789012'} onChange={(e) => setDraft(e.target.value)} /></label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>Save read policy</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </form>
      ) : entries.length === 0 ? <Empty>No entries.</Empty> : (
        <ul className="flex flex-wrap gap-1.5">{entries.map((x) => <li key={x} className="rounded-md border px-2 py-0.5 font-mono text-xs break-all">{x}</li>)}</ul>
      )}
    </Panel>
  );
}
