// Logged out, the page is only the landing page (issue #213): the hopper's name and the ways to sign in — a button per GitHub realm (a device code, issue #214), per OIDC or SAML realm (the sign-in config), a username
// and password form while an LDAP realm is on, and continuing without sign-in while `none` is on. The
// login code is not offered here (issue #247): its device link signs a browser in by itself (main.tsx).
// Design: design.md "Sign-in: realms", "Reaching
// the UI across the LAN". Nothing of the app — navigation, views, notices — and no read but the
// session's until someone signs in (issues #167, #213).
import { AlertTriangle, LogIn } from 'lucide-react';
import logo from '../../../site/hopper-logo.svg';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { beginDeviceSignIn, beginSignIn, pollDeviceSignIn, signInThroughGateway, signInWithPassword, signInWithoutCredential, type DeviceSignIn } from '@/lib/login';
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

const POLL_MS = 2000;

/**
 * Sign in with GitHub (issue #214): the device code through the hopper's app, entered at the
 * provider; the page follows the sign-in and loads signed in once it is approved. The same sign-in
 * connects the account the person's jobs work through.
 */
function DeviceSignInButton({ realm }: { realm: { name: string; label: string } }) {
  const [s, setS] = useState<DeviceSignIn | null>(null);
  useEffect(() => {
    if (!s) return;
    let live = true;
    const t = setInterval(() => {
      void pollDeviceSignIn(s).then((r) => {
        if (!live || r === null) return;
        setS(null);
        finish(r === '' ? null : r);
      });
    }, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [s]);
  const start = async () => {
    const r = await beginDeviceSignIn(realm.name);
    if ('error' in r) toast.error(r.error); else setS(r);
  };
  if (!s) return <Button size="xs" variant="outline" onClick={() => void start()}><LogIn />Sign in with {realm.label}</Button>;
  return (
    <div data-device-sign-in={realm.name} className="w-full space-y-1.5 rounded-md border p-2 text-foreground">
      <div>Open <a className="underline" href={s.verificationUri} target="_blank" rel="noreferrer">{s.verificationUri}</a>, sign in to {realm.label}, and enter this code:</div>
      <code data-device-code className="inline-block rounded border px-2 py-1 font-mono text-lg font-semibold tracking-widest select-all">{s.userCode}</code>
      <div className="text-muted-foreground">waiting for {realm.label} — this page signs you in once the code is approved. It also connects your {realm.label}: your jobs work through it.</div>
    </div>
  );
}

/** Every way the sign-in config offers to sign in, as buttons and forms. */
function SignInOptions({ signIn, lead }: { signIn: SessionView['signIn']; lead: string }) {
  if (!signIn.password && !signIn.gateway && !signIn.none && signIn.realms.length === 0 && (signIn.devices ?? []).length === 0) {
    return <>Sign-in with GitHub is not set up on this hopper yet.</>;
  }
  const elsewhere = signIn.realms.length > 0 && location.origin !== signIn.origin;
  return (
    <>
      {lead}{elsewhere && <> at <a className="text-foreground underline" href={signIn.origin}>{signIn.origin}</a></>}:
      {(signIn.devices ?? []).map((p) => <DeviceSignInButton key={p.name} realm={p} />)}
      {signIn.realms.map((p) => (
        <Button key={p.name} size="xs" variant="outline" onClick={() => beginSignIn(p.name, signIn.origin)}><LogIn />Sign in with {p.label}</Button>
      ))}
      {signIn.gateway && <Button size="xs" variant="outline" onClick={() => void signInThroughGateway().then(finish)}><LogIn />Sign in through the gateway</Button>}
      {signIn.password && <PasswordSignIn />}
      {signIn.none && <Button size="xs" variant="outline" onClick={() => void signInWithoutCredential().then(finish)}><LogIn />Continue as {signIn.none}</Button>}
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
