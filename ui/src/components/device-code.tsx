// A device code to enter at the provider (issues #214, #258): laid out around the code — the code large
// and centred, a copy button beside it, the provider one press away (the press copies the code too), how
// long the code lasts, and the way back. The landing page's GitHub sign-in and Sources' Connect GitHub
// both show it.
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const copyText = (text: string): Promise<boolean> =>
  navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false);

/** mm:ss left until `at`, or null once it has passed (or no time was given). */
function useLeft(at: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  if (!at) return null;
  const s = Math.floor((new Date(at).getTime() - now) / 1000);
  if (!(s > 0)) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function DeviceCode({ provider, userCode, verificationUri, expiresAt, waiting, note, onCancel, cancelDisabled, className, ...rest }: {
  provider: string; userCode: string; verificationUri: string; expiresAt?: string;
  /** What the page is waiting for, under the code: a few words. */
  waiting: ReactNode;
  /** A last line in small print. */
  note?: ReactNode;
  onCancel: () => void; cancelDisabled?: boolean; className?: string;
} & Record<`data-${string}`, string>) {
  const [copied, setCopied] = useState(false);
  const left = useLeft(expiresAt);
  const copy = () => void copyText(userCode).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } });
  return (
    <div {...rest} className={cn('flex flex-col items-center gap-4 text-center', className)}>
      <div className="text-sm font-medium text-foreground">Enter this code on {provider}</div>
      <div className="flex items-center gap-1.5 rounded-xl border bg-background/60 py-2 pr-2 pl-4 shadow-inner">
        <code data-device-code className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground select-all sm:text-3xl">{userCode}</code>
        <Button variant="ghost" size="icon-sm" aria-label="Copy code" title="Copy code" onClick={copy}>{copied ? <Check className="text-ok" /> : <Copy />}</Button>
      </div>
      <a data-open-provider href={verificationUri} target="_blank" rel="noreferrer" onClick={copy}
        className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full max-w-xs gap-2')}>
        Open {provider}<ExternalLink />
      </a>
      <div className="-mt-2 text-[0.7rem] text-muted-foreground/80">or go to <span className="font-mono text-muted-foreground">{verificationUri.replace(/^https?:\/\//, '')}</span></div>
      <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
        <div className="flex items-center gap-2"><Loader2 className="size-3.5 shrink-0 animate-spin text-[#1ecad4] motion-reduce:animate-none" />{waiting}</div>
        {left && <div className="num text-[0.7rem] text-muted-foreground/80">The code expires in {left}</div>}
      </div>
      {note && <div className="max-w-xs text-[0.7rem] leading-relaxed text-muted-foreground/80">{note}</div>}
      <Button variant="ghost" size="sm" disabled={cancelDisabled} onClick={onCancel}>Cancel</Button>
    </div>
  );
}
