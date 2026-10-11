// A template's read-only check on Settings → Vault (issue #716, design.md "The read-only check"): for a template a job
// asked for with read needs only, whether the check of its current version passed, and a button to run it again.
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkText } from '@/model/vault';
import type { TemplateView } from '@/model/wire';
import type { Send } from './vault';

/** Its row in the template's facts; nothing for a template that takes no check. */
export function CheckRow({ t }: { t: TemplateView }) {
  const check = checkText(t);
  if (!check) return null;
  return <><dt className="text-muted-foreground">Read-only check</dt><dd className={`break-words ${check.waits ? 'text-warn' : ''}`}>{check.text}</dd></>;
}

/** Runs the check again at the next check pass; not while it runs. */
export function CheckAgain({ t, can, busy, send }: { t: TemplateView; can: boolean; busy: boolean; send: Send }) {
  if (!checkText(t) || t.check?.state === 'running') return null;
  return <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => void send({ action: 'check-template', name: t.name }, `${t.name}: the read-only check runs again`)}><RefreshCw />Run the check again</Button>;
}
