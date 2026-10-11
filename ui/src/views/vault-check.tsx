// A template's read-only check on Settings → Vault (issue #716, design.md "The read-only check"): for a template a job
// asked for with read needs only, whether the check of its current version passed (beside who approved it), and a button to run it again.
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkText } from '@/model/vault';
import type { TemplateView } from '@/model/wire';
import type { Send } from './vault';

/** The template's gates in its facts: the read-only check (nothing for a template that takes none), then who approved it. */
export function GateRows({ t }: { t: TemplateView }) {
  const check = checkText(t);
  return <>
    {check && <><dt className="text-muted-foreground">Read-only check</dt><dd className={`break-words ${check.waits ? 'text-warn' : ''}`}>{check.text}</dd></>}
    {t.approval && <><dt className="text-muted-foreground">Approved by</dt><dd className="break-words">{t.approval.by} · {new Date(t.approval.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></>}
  </>;
}

/** Runs the check again at the next check pass; not while it runs. */
export function CheckAgain({ t, can, busy, send }: { t: TemplateView; can: boolean; busy: boolean; send: Send }) {
  if (!checkText(t) || t.check?.state === 'running') return null;
  return <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => void send({ action: 'check-template', name: t.name }, `${t.name}: the read-only check runs again`)}><RefreshCw />Run the check again</Button>;
}
