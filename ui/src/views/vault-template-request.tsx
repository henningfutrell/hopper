// Vault, the template request (issue #708, part 9): an admin writes what the box must do — in plain words, or its
// needs, one operation profile each, as a job's `sandbox-template --needs` says them — and the hopper shows the template it makes from them
// before it is made (`preview-template`): its name, its image, the tools its needs use, no vault secret, and who approves
// it. Ask for it then makes it (`request-template`), the same path as a job's request. Changed needs are shown again
// before it is asked for, so what is asked for is what was shown.
import { Eye, Hammer } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Panel } from '@/components/panel';
import { Label } from '@/components/vault-fields';
import { post, SessionRejected } from '@/lib/api';
import { REQUEST_SECRETS, requestApproval, requestExists } from '@/model/vault-template-request';
import type { TemplatePreview, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Asked = VaultView & { request: { template?: string; ready: boolean; text: string } };

function Shown({ p }: { p: TemplatePreview }) {
  const exists = requestExists(p);
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>Template <span className="font-mono break-all">{p.template}</span></p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Image</dt><dd className="font-mono text-xs break-all">{p.image}</dd>
        <dt className="text-muted-foreground">Tools</dt><dd>{p.tools.length ? p.tools.join(', ') : 'none'}</dd>
        <dt className="text-muted-foreground">Needs</dt><dd><ul>{p.needs.map((n) => <li key={n}>{n}</li>)}</ul></dd>
        <dt className="text-muted-foreground">Secrets</dt><dd>{REQUEST_SECRETS}</dd>
      </dl>
      <p className={p.approvedBy === 'a person' ? 'text-warn' : 'text-good'}>{requestApproval(p)}</p>
      {exists && <p className="text-muted-foreground">{exists}</p>}
    </div>
  );
}

export function TemplateRequest({ onView }: { onView: (v: VaultView) => void }) {
  const can = useCanAdmin();
  const [needs, setNeeds] = useState('');
  const [shown, setShown] = useState<TemplatePreview | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can) return null;
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const show = () => run(async () => {
    setAnswer(null);
    setShown((await post<{ preview: TemplatePreview }>('/ui/api/vault', { action: 'preview-template', needs })).preview);
  });
  const ask = () => run(async () => {
    const r = await post<Asked>('/ui/api/vault', { action: 'request-template', needs });
    onView(r);
    setAnswer(r.request.text);
    setShown(null);
    toast.success(r.request.ready ? `Template ${r.request.template} is ready` : `Template ${r.request.template} waits`);
  });
  return (
    <Panel title="Template request" icon={Hammer} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">Write what a box must do, in plain words, and the hopper makes its template: the box image with the tools that work uses, one operation profile per need, and no secret. You see the needs it read and the template before it is made. A job asks for one the same way.</p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void show(); }}>
        <label className="block space-y-1"><Label>One line each — plain words (get pods on cluster lab) or a need (read/cluster/lab)</Label>
          <Textarea className="font-mono text-sm" rows={4} value={needs} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={'kubectl get pods in namespace web on cluster lab\nterraform plan on workspace network\nread/aws-account/123456789012'} onChange={(e) => { setNeeds(e.target.value); setShown(null); }} /></label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy || needs.trim() === ''}><Eye />Show the template</Button>
          {shown && <Button type="button" disabled={busy || shown.exists === 'changed'} onClick={() => void ask()}>Ask for it</Button>}
        </div>
      </form>
      {shown && <Shown p={shown} />}
      {answer && <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{answer}</p>}
    </Panel>
  );
}
