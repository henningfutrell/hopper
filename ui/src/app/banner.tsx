// Logged out: the ways to sign in — a button per identity provider (auth.yaml), and, while local
// sign-in is on, the login code (the command on this machine, a device link or a pasted code across
// the LAN). Design: design.md "Sign-in: local, OIDC and SAML", "Reaching the UI across the LAN".
import { Copy, Lock, LogIn } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LOGIN_CMD } from '@/lib/api';
import { beginSignIn, onLan, submitLogin } from '@/lib/login';
import { useHopper } from '@/store';

function LoginCode() {
  const [code, setCode] = useState('');
  const copy = () => navigator.clipboard?.writeText(LOGIN_CMD).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <>
      {onLan() ? <>Open a device link from a logged-in browser, or paste a login code:</> : <>
        Or run
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/90">{LOGIN_CMD}</code>
        <Button variant="ghost" size="icon-xs" aria-label="Copy command" onClick={copy}><Copy /></Button>
        or paste a login code:
      </>}
      <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (code.trim()) submitLogin(code); }}>
        <Input aria-label="Login code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="login code"
          autoComplete="off" spellCheck={false} className="h-7 w-44 font-mono text-xs" />
        <Button type="submit" size="xs" variant="outline" disabled={!code.trim()}><LogIn />Log in</Button>
      </form>
    </>
  );
}

export function ReadOnlyBanner() {
  const authed = useHopper((s) => s.authed);
  const signIn = useHopper((s) => s.signIn);
  if (authed || !signIn) return null;
  const elsewhere = signIn.providers.length > 0 && location.origin !== signIn.origin;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Lock className="size-3.5" />
      Read-only. To act, sign in{elsewhere && <> at <a className="text-foreground underline" href={signIn.origin}>{signIn.origin}</a></>}:
      {signIn.providers.map((p) => (
        <Button key={p.name} size="xs" variant="outline" onClick={() => beginSignIn(p.name, signIn.origin)}><LogIn />Sign in with {p.label}</Button>
      ))}
      {signIn.local && <LoginCode />}
      {!signIn.local && signIn.providers.length === 0 && <>no way to sign in is configured (auth.yaml).</>}
    </div>
  );
}
