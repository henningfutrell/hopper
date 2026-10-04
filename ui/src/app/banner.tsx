// Read-only until logged in: say how — the command on this machine, a device link or a pasted
// login code across the LAN (design.md "Reaching the UI across the LAN").
import { Copy, Lock, LogIn } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LOGIN_CMD } from '@/lib/api';
import { onLan, submitLogin } from '@/lib/login';
import { useHopper } from '@/store';

export function ReadOnlyBanner() {
  const authed = useHopper((s) => s.authed);
  const [code, setCode] = useState('');
  if (authed) return null;
  const copy = () => navigator.clipboard?.writeText(LOGIN_CMD).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Lock className="size-3.5" />
      {onLan() ? <>Logged out. Open a device link from a logged-in browser, or paste a login code:</> : <>
        Read-only. To act, run
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/90">{LOGIN_CMD}</code>
        <Button variant="ghost" size="icon-xs" aria-label="Copy command" onClick={copy}><Copy /></Button>
        or paste a login code:
      </>}
      <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (code.trim()) submitLogin(code); }}>
        <Input aria-label="Login code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="login code"
          autoComplete="off" spellCheck={false} className="h-7 w-44 font-mono text-xs" />
        <Button type="submit" size="xs" variant="outline" disabled={!code.trim()}><LogIn />Log in</Button>
      </form>
    </div>
  );
}
