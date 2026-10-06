// Logged out, the page is only the landing page (issue #213): the hopper's name and the ways to sign in — a button per GitHub realm, per OIDC or SAML realm (the sign-in config), a username
// and password form while an LDAP realm is on, and continuing without sign-in while `none` is on. The
// login code is not offered here (issue #247): its device link signs a browser in by itself (main.tsx).
// GitHub (issues #214, #258): to GitHub and back in this browser when the hopper can (`redirect`, on the
// sign-in origin), else the device code; the code stays a link away. The sign-in card over a backdrop
// in the logo's teal — lanes of jobs going by (index.css "landing"); on a wide screen, beside it, a panel
// says what the hopper does in three steps (issue #266). A phone gets the card alone.
// Design: design.md "Sign-in: realms", "Reaching
// the UI across the LAN". Nothing of the app — navigation, views, notices — and no read but the
// session's until someone signs in (issues #167, #213).
import { AlertTriangle, ArrowRight, Cpu, GitPullRequest, KeyRound, LogIn, Tag, type LucideIcon } from 'lucide-react';
import logo from '../../../site/hopper-logo.svg';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DeviceCode } from '@/components/device-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { beginDeviceSignIn, beginSignIn, pollDeviceSignIn, signInThroughGateway, signInWithPassword, signInWithoutCredential, type DeviceSignIn } from '@/lib/login';
import type { SessionView } from '@/model/wire';
import { useHopper } from '@/store';

type Offer = SessionView['signIn'];
type DeviceRealm = Offer['devices'][number];

/** Ends a JSON sign-in: toast its error, or load the page (the landing page read nothing yet). */
const finish = (error: string | null) => {
  if (error) toast.error(error);
  else location.reload();
};

/** GitHub's mark (Octicons, MIT): the button says whose sign-in it is at a glance. */
const GitHubMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[1.15rem] fill-current">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.37A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
  </svg>
);

function PasswordSignIn() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = async () => { finish(await signInWithPassword(username.trim(), password)); setPassword(''); };
  return (
    <form className="flex w-full flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (username.trim() && password) void submit(); }}>
      <Input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username"
        autoComplete="username" className="h-10" />
      <Input aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
        autoComplete="current-password" className="h-10" />
      <Button type="submit" variant="outline" className="h-10 w-full" disabled={!username.trim() || !password}><KeyRound />Sign in</Button>
    </form>
  );
}

const POLL_MS = 2000;

/**
 * Sign in with GitHub by its device code (issue #214): the code through the hopper's app, entered at the
 * provider; the page follows the sign-in and loads signed in once it is approved. The same sign-in
 * connects the account the person's jobs work through.
 */
function DeviceSignInPanel({ realm, s, onEnd }: { realm: DeviceRealm; s: DeviceSignIn; onEnd: () => void }) {
  useEffect(() => {
    let live = true;
    const t = setInterval(() => {
      void pollDeviceSignIn(s).then((r) => {
        if (!live || r === null) return;
        onEnd();
        finish(r === '' ? null : r);
      });
    }, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [s, onEnd]);
  return (
    <DeviceCode data-device-sign-in={realm.name} provider={realm.label} userCode={s.userCode} verificationUri={s.verificationUri}
      {...(s.expiresAt ? { expiresAt: s.expiresAt } : {})}
      waiting={<>Waiting for you to approve it</>}
      note={<>This page signs you in once you do. Signing in with {realm.label} also connects it: your jobs work through it.</>}
      onCancel={onEnd} />
  );
}

/** The big button of a GitHub realm, and the device code when the browser cannot go to GitHub and back. */
function GitHubSignIn({ realm, origin, onCode }: { realm: DeviceRealm; origin: string; onCode: (s: DeviceSignIn) => void }) {
  const [busy, setBusy] = useState(false);
  const redirect = realm.redirect === true && location.origin === origin;
  const code = async () => {
    setBusy(true);
    const r = await beginDeviceSignIn(realm.name);
    setBusy(false);
    if ('error' in r) toast.error(r.error); else onCode(r);
  };
  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      <Button disabled={busy} onClick={() => (redirect ? beginSignIn(realm.name, origin) : void code())}
        className="h-11 w-full gap-2.5 rounded-xl bg-white text-[0.95rem] font-semibold text-neutral-900 shadow-lg shadow-black/30 hover:bg-white/90">
        <GitHubMark />Sign in with {realm.label}
      </Button>
      {redirect && <Button variant="link" size="sm" className="h-6 text-xs text-muted-foreground" disabled={busy} onClick={() => void code()}>Use a code instead</Button>}
    </div>
  );
}

/** A thin rule with a word in it, between groups of ways to sign in. */
const Or = () => (
  <div className="flex w-full items-center gap-3 text-[0.7rem] tracking-wider text-muted-foreground/70 uppercase" aria-hidden="true">
    <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
  </div>
);

/** Every way the sign-in config offers to sign in, as buttons and forms, in groups. */
function SignInOptions({ signIn, onCode }: { signIn: Offer; onCode: (realm: DeviceRealm, s: DeviceSignIn) => void }) {
  const devices = signIn.devices ?? [];
  if (!signIn.password && !signIn.gateway && !signIn.none && signIn.realms.length === 0 && devices.length === 0) {
    return <p className="text-sm text-muted-foreground">Sign-in with GitHub is not set up on this hopper yet.</p>;
  }
  const elsewhere = signIn.realms.length > 0 && location.origin !== signIn.origin;
  const groups: ReactNode[] = [];
  if (devices.length) groups.push(<div key="github" className="flex w-full flex-col gap-2">{devices.map((p) => <GitHubSignIn key={p.name} realm={p} origin={signIn.origin} onCode={(s) => onCode(p, s)} />)}</div>);
  const others = [
    ...signIn.realms.map((p) => (
      <Button key={p.name} variant="outline" className="h-10 w-full" onClick={() => beginSignIn(p.name, signIn.origin)}><LogIn />Sign in with {p.label}</Button>
    )),
    ...(signIn.gateway ? [<Button key="gateway" variant="outline" className="h-10 w-full" onClick={() => void signInThroughGateway().then(finish)}><LogIn />Sign in through the gateway</Button>] : []),
  ];
  if (others.length) {
    groups.push(
      <div key="others" className="flex w-full flex-col gap-2">
        {elsewhere && <p className="text-xs text-muted-foreground">Single sign-on works at <a className="text-foreground underline underline-offset-2" href={signIn.origin}>{signIn.origin}</a></p>}
        {others}
      </div>,
    );
  }
  if (signIn.password) groups.push(<PasswordSignIn key="password" />);
  if (signIn.none) {
    groups.push(<Button key="none" variant="ghost" className="h-10 w-full" onClick={() => void signInWithoutCredential().then(finish)}>Continue as {signIn.none}<ArrowRight /></Button>);
  }
  // GitHub first; the rest after one rule, not a rule between each.
  if (!devices.length || groups.length === 1) return <>{groups}</>;
  return <>{groups[0]}<Or /><div className="flex w-full flex-col gap-3">{groups.slice(1)}</div></>;
}

/** The night sky behind the page: aurora light, a dot grid, and lanes with jobs going along them. index.css "landing". */
const Backdrop = () => (
  <div className="landing-backdrop" aria-hidden="true">
    <div className="landing-aurora a" />
    <div className="landing-aurora b" />
    <div className="landing-aurora c" />
    <div className="landing-grid" />
    <div className="landing-lanes">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="landing-lane" />)}</div>
    <div className="landing-grain" />
    <div className="landing-vignette" />
  </div>
);

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Tag, title: 'Label an issue', text: 'Give a GitHub issue the hopper label: it is a job now.' },
  { icon: Cpu, title: 'It runs on your machine', text: 'A coding agent works on it, on a machine of yours, inside its usage budget.' },
  { icon: GitPullRequest, title: 'Review the pull request', text: 'The work comes back as a pull request. A question it cannot answer comes to you.' },
];

/** Beside the card on a wide screen: what the hopper does, in three steps joined by a lane. */
const Showcase = () => (
  <section data-landing-showcase className="relative hidden flex-col justify-center px-12 py-16 lg:flex xl:px-20">
    <div className="max-w-xl animate-in duration-700 fade-in-0 slide-in-from-left-4 motion-reduce:animate-none">
      <p className="text-xs font-semibold tracking-[0.2em] text-[#1ecad4] uppercase">A job queue for coding agents</p>
      <h2 className="landing-headline mt-4 text-5xl leading-[1.05] font-semibold tracking-tight text-balance xl:text-6xl">Your GitHub issues, worked on your machines.</h2>
      <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground text-pretty">
        hopper takes the issues you choose, runs each one on a computer you trust, and keeps you in the loop.
      </p>
      <ol className="landing-steps relative mt-10 flex flex-col gap-6">
        {STEPS.map(({ icon: Icon, title, text }) => (
          <li key={title} data-landing-step className="relative flex items-start gap-4">
            <span className="relative z-10 grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-card/80 text-[#1ecad4] shadow-lg shadow-black/40 backdrop-blur">
              <Icon className="size-[1.1rem]" />
            </span>
            <div className="pt-1">
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  </section>
);

/** Logged out: the hopper's name and the ways to sign in, or that the hopper could not be reached. Nothing else. */
export function Landing() {
  const signIn = useHopper((s) => s.signIn);
  const [device, setDevice] = useState<{ realm: DeviceRealm; s: DeviceSignIn } | null>(null);
  const [end] = useState(() => () => setDevice(null));
  return (
    <main data-slot="landing" className="dark relative isolate grid min-h-dvh overflow-hidden text-foreground lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Backdrop />
      <Showcase />
      <div className="relative flex items-center justify-center px-4 py-10 lg:px-12">
        <div data-landing-card className="relative w-full max-w-sm animate-in duration-500 fade-in-0 zoom-in-95 motion-reduce:animate-none">
          <div className="relative rounded-2xl border border-white/10 bg-card/70 px-7 pt-9 pb-7 shadow-2xl shadow-black/60 backdrop-blur-xl">
            <div className="landing-glow" />
            <div className="mb-7 flex flex-col items-center text-center">
              <img src={logo} alt="" className="h-16 w-auto drop-shadow-[0_0_24px_rgb(30_202_212/0.45)]" />
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">hopper</h1>
              <p className="mt-1.5 text-sm text-muted-foreground lg:hidden">Your GitHub issues, worked on your machines.</p>
              <p className="mt-1.5 hidden text-sm text-muted-foreground lg:block">Sign in to see your jobs.</p>
            </div>
            <div className="flex flex-col items-center gap-4">
              {!signIn ? (
                <div className="flex items-center justify-center gap-2 text-center text-sm text-bad"><AlertTriangle className="size-4 shrink-0" />Could not reach the hopper. Reload the page to try again.</div>
              ) : device ? (
                <DeviceSignInPanel realm={device.realm} s={device.s} onEnd={end} />
              ) : (
                <SignInOptions signIn={signIn} onCode={(realm, s) => setDevice({ realm, s })} />
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
