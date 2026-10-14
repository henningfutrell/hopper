// Remote access in the UI (issues #880, #968), pure: the tunnel's status in one line, a credential's line (never its value),
// the change a save sends, and the copy-out panel's lines. The daemon checks each part again; this only says early what it
// will refuse.
import type { CredentialMeta, RemoteAccessChange, RemoteAccessProvider, RemoteAccessView } from './wire.ts';

/** The providers, in the order the picker offers them: equal alternatives, neither a fallback for the other. */
export const PROVIDERS: RemoteAccessProvider[] = ['cloudflare', 'ngrok'];

export const PROVIDER_NAME: Record<RemoteAccessProvider, string> = { cloudflare: 'Cloudflare Tunnel', ngrok: 'ngrok' };

/** Each provider's one credential: its name, where a person makes it, what it needs. The daemon checks it again. */
export const CREDENTIAL_HELP: Record<RemoteAccessProvider, { name: string; where: string; needs: string; shape: RegExp }> = {
  cloudflare: {
    name: 'API token', where: 'https://dash.cloudflare.com/profile/api-tokens', shape: /^[A-Za-z0-9_-]{30,200}$/,
    needs: 'Make a custom token with Account → Cloudflare Tunnel → Edit, and Zone → DNS → Edit on the zone of the host name.',
  },
  ngrok: {
    name: 'API key', where: 'https://dashboard.ngrok.com/api-keys', shape: /^[A-Za-z0-9_]{20,200}$/,
    needs: 'Make an API key. The hopper takes the account\'s domain, or reserves one.',
  },
};

export interface RemoteAccessDraft { provider: RemoteAccessProvider; credential: string; domain: string }

const DOMAIN = /^(https:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?\/?$/i;

/** Where the tunnel is, in one line. */
export function remoteAccessStatusLine(v: RemoteAccessView): string {
  const s = v.status;
  if (s.state === 'off') return 'Off: the hopper is not reached from the internet';
  if (s.state === 'up') return `Up: agents reach the hopper's API at ${s.url ?? ''}`;
  if (s.state === 'no-service') return `No tunnel service: ${s.error ?? 'none asks for the settings'}`;
  return `Down: ${s.error ?? 'the tunnel is starting'}`;
}

/** A provider's credential kept: its last 4 characters, who set it and when. */
export function credentialLine(provider: RemoteAccessProvider, m: CredentialMeta | undefined): string {
  const name = `${PROVIDER_NAME[provider]} ${CREDENTIAL_HELP[provider].name}`;
  if (!m) return `No ${name} kept.`;
  const when = new Date(m.setAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `${name} kept: ${m.last4 ? `ends in ${m.last4}, ` : ''}set by ${m.setBy}, ${when}.`;
}

/** The provider the form shows: the one picked, else the first the picker offers (Cloudflare). */
export const draftOf = (v: Pick<RemoteAccessView, 'provider' | 'domain'>): RemoteAccessDraft => ({ provider: v.provider ?? 'cloudflare', credential: '', domain: v.domain ?? '' });

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function remoteAccessSave(v: Pick<RemoteAccessView, 'provider' | 'domain'>, d: RemoteAccessDraft): { ok: true; change: RemoteAccessChange | undefined } | { ok: false; error: string } {
  const domain = d.domain.trim();
  const credential = d.credential.trim();
  const change: RemoteAccessChange = {};
  if (d.provider !== v.provider) change.provider = d.provider;
  if (credential !== '') {
    if (!CREDENTIAL_HELP[d.provider].shape.test(credential)) return { ok: false, error: `${CREDENTIAL_HELP[d.provider].name}: that is no ${PROVIDER_NAME[d.provider]} ${CREDENTIAL_HELP[d.provider].name}` };
    change.credential = credential;
  }
  if (domain !== (v.domain ?? '')) {
    if (domain === '') change.domain = null;
    else if (!DOMAIN.test(domain)) return { ok: false, error: 'Host name: a host name, such as hopper.example.com, or empty to let the hopper pick one' };
    else change.domain = domain;
  }
  return { ok: true, change: Object.keys(change).length > 0 ? change : undefined };
}

/** The copy-out panel: the public URL and the URLs an agent calls, each to copy, while remote access is on. */
export function copyOut(v: Pick<RemoteAccessView, 'links'>): { label: string; value: string }[] {
  const l = v.links;
  if (!l) return [];
  return [
    { label: 'Public URL', value: l.url },
    { label: 'API', value: l.api },
    { label: 'API-token exchange', value: l.apiToken },
    { label: 'Token refresh', value: l.tokenRefresh },
  ];
}
