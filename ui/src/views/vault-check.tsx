// A template's read-only check on Vault (issue #716, design.md "The read-only check"): for a template a job
// asked for with read needs only, whether the check of its current version passed (beside who approved it), a link to its
// check report (issue #715: an artifact of the job that asked for the template), and a button to run it again.
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkText, probeMarksText } from '@/model/vault';
import type { TemplateView } from '@/model/wire';
import type { Send } from './vault';
import { BackendRows } from './vault-state-backend';

/** The template's gates in its facts: the read-only check (nothing for a template that takes none), then who approved it. */
export function GateRows({ t }: { t: TemplateView }) {
  const check = checkText(t);
  const marks = probeMarksText(t.probeMarks);
  return <>
    <BackendRows t={t} />
    {check && <><dt className="text-muted-foreground">Read-only check</dt><dd className={`break-words ${check.waits ? 'text-warn' : ''}`}>{check.text}{check.report && <> · <a className="underline" href={check.report}>Check report</a></>}</dd></>}
    {marks.length > 0 && <><dt className="text-muted-foreground">Probe marks</dt><dd className="break-words font-mono text-xs">{marks.join(', ')}</dd></>}
    {t.approval && <><dt className="text-muted-foreground">Approved by</dt><dd className="break-words">{t.approval.by} · {new Date(t.approval.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></>}
  </>;
}

/** Runs the check again at the next check pass; not while it runs. */
export function CheckAgain({ t, can, busy, send }: { t: TemplateView; can: boolean; busy: boolean; send: Send }) {
  if (!checkText(t) || t.check?.state === 'running') return null;
  return <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => void send({ action: 'check-template', name: t.name }, `${t.name}: the read-only check runs again`)}><RefreshCw />Run the check again</Button>;
}
