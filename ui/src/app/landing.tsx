// Logged out, the page is only the landing page (issue #213): the hopper's name and the ways to sign in — a button per OIDC, GitHub or SAML realm (the sign-in config), a username
// and password form while an LDAP realm, or a password realm with an account, is on, continuing without sign-in while `none` is on, and,
// while local sign-in is on, the login code (the command on this machine, a device link or a pasted
// code across the LAN). Design: design.md "Sign-in: realms", "Reaching
// the UI across the LAN". Nothing of the app — navigation, views, notices — and no read but the
// session's until someone signs in (issues #167, #213).
import { AlertTriangle, Copy, LogIn } from 'lucide-react';
import logo from '../../../site/hopper-logo.svg';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LOGIN_CMD } from '@/lib/api';
import { beginSignIn, onLan, signInThroughGateway, signInWithPassword, signInWithoutCredential, submitLogin } from '@/lib/login';
import type { SessionView } from '@/model/wire';
import { useHopper } from '@/store';

/** Ends a JSON sign-in: toast its error, or load the page (the landing page read nothing yet). */
const finish = (error: string | null) => {
  if (error) toast.error(error);
  else location.reload();
};

function PasswordSignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = async () => { finish(await signInWithPassword(username.trim(), password)); setPassword(''); };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (username.trim() && password) void submit(); }}>
      <Input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username"
        autoComplete="username" className="h-7 w-32 text-xs" />
      <Input aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password"
        autoComplete="current-password" className="h-7 w-32 text-xs" />
      <Button type="submit" size="xs" variant="outline" disabled={!username.trim() || !password}><LogIn />Sign in</Button>
    </form>
  );
}

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

/** Every way the sign-in config offers to sign in, as buttons and forms. */
function SignInOptions({ signIn, lead }: { signIn: SessionView['signIn']; lead: string }) {
  const elsewhere = signIn.realms.length > 0 && location.origin !== signIn.origin;
  return (
    <>
      {lead}{elsewhere && <> at <a className="text-foreground underline" href={signIn.origin}>{signIn.origin}</a></>}:
      {signIn.realms.map((p) => (
        <Button key={p.name} size="xs" variant="outline" onClick={() => beginSignIn(p.name, signIn.origin)}><LogIn />Sign in with {p.label}</Button>
      ))}
      {signIn.gateway && <Button size="xs" variant="outline" onClick={() => void signInThroughGateway().then(finish)}><LogIn />Sign in through the gateway</Button>}
      {signIn.password && <PasswordSignIn />}
      {signIn.none && <Button size="xs" variant="outline" onClick={() => void signInWithoutCredential().then(finish)}><LogIn />Continue as {signIn.none}</Button>}
      {signIn.local && <LoginCode />}
      {!signIn.local && !signIn.password && !signIn.gateway && !signIn.none && signIn.realms.length === 0 && <>no way to sign in is on: where the hopper runs, turn the login code on in its sign-in config (<code className="font-mono">hopper config get sign-in</code>, then <code className="font-mono">hopper config set sign-in</code>) and restart it.</>}
    </>
  );
}

/** Logged out: the hopper's name and the ways to sign in, or that the hopper could not be reached. Nothing else. */
export function Landing() {
  const signIn = useHopper((s) => s.signIn);
  return (
    <div data-slot="landing" className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-xl space-y-4 rounded-lg border p-5">
        <div className="flex items-center gap-2 font-semibold tracking-tight"><img src={logo} alt="" className="h-8 w-auto" />hopper</div>
        {signIn ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><SignInOptions signIn={signIn} lead="Sign in" /></div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-bad"><AlertTriangle className="size-4" />Could not reach the hopper. Reload the page to try again.</div>
        )}
      </div>
    </div>
  );
}
