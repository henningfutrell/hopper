// Remote access in the UI (issue #880), pure: the tunnel's status in one line, the authtoken's line (never its value), and
// the change a save sends. The daemon checks the domain and the token again; this only says early what it will refuse.
import type { RemoteAccessChange, RemoteAccessView } from './wire.ts';

export interface RemoteAccessDraft { domain: string; authtoken: string }

const DOMAIN = /^(https:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?\/?$/i;
const DOMAIN_ERROR = 'Domain: the domain reserved at ngrok, such as hopper.example.ngrok.app';

/** Where the tunnel is, in one line. */
export function remoteAccessStatusLine(v: RemoteAccessView): string {
  const s = v.status;
  if (s.state === 'off') return 'Off: the hopper is not reached from the internet';
  if (s.state === 'up') return `Up: agents reach the hopper's API at ${s.url ?? ''}`;
  if (s.state === 'no-service') return `No tunnel service: ${s.error ?? 'none asks for the settings'}`;
  return `Down: ${s.error ?? 'the tunnel is starting'}`;
}

/** The authtoken kept: its last 4 characters, who set it and when. */
export function authtokenLine(v: Pick<RemoteAccessView, 'authtoken'>): string {
  const t = v.authtoken;
  if (!t) return 'No authtoken kept.';
  const when = new Date(t.setAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `Kept: ${t.last4 ? `ends in ${t.last4}, ` : ''}set by ${t.setBy}, ${when}.`;
}

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function remoteAccessSave(v: Pick<RemoteAccessView, 'domain'>, d: RemoteAccessDraft): { ok: true; change: RemoteAccessChange | undefined } | { ok: false; error: string } {
  const domain = d.domain.trim();
  const token = d.authtoken.trim();
  const change: RemoteAccessChange = {};
  if (domain !== (v.domain ?? '')) {
    if (!DOMAIN.test(domain)) return { ok: false, error: DOMAIN_ERROR };
    change.domain = domain;
  }
  if (token !== '') change.authtoken = token;
  return { ok: true, change: Object.keys(change).length > 0 ? change : undefined };
}
