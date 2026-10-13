// Remote access (issues #880, #968, design.md "Remote access"): the tunnel's settings, kept by the hopper and set in the
// UI. Off by default. The admin picks a provider — Cloudflare Tunnel or ngrok, equal alternatives — and gives that
// provider's one credential (a Cloudflare API token, an ngrok API key), a system secret of the instance's vault. Turned on,
// the hopper mints the tunnel itself: its token, its domain and, at Cloudflare, its DNS record (`provisioned`); turned off
// or switched, it revokes what it minted and removes it. Pure: the shapes, the checks and the words for what a tunnel says.

/** The providers a tunnel runs through, in the order the picker offers them. Neither is a fallback for the other. */
export const PROVIDERS = ['cloudflare', 'ngrok'] as const;
export type RemoteAccessProvider = (typeof PROVIDERS)[number];

/** A provider's name as people read it. */
export const PROVIDER_NAME: Record<RemoteAccessProvider, string> = { cloudflare: 'Cloudflare Tunnel', ngrok: 'ngrok' };

/**
 * What the hopper minted at the provider, to run the tunnel with and to remove again. Its token is a system secret
 * (`remote-access.<provider>-tunnel-token`), never here. `domain` is the public host name the tunnel answers at.
 */
export type Provisioned =
  | {
    provider: 'ngrok';
    domain: string;
    /** The tunnel credential the hopper minted (its authtoken). Absent: an authtoken given by hand before issue #968, kept. */
    credentialId?: string;
    /** The domain the hopper reserved, removed again on release. Absent: a domain the account had: kept. */
    reservedDomainId?: string;
  }
  | { provider: 'cloudflare'; domain: string; accountId: string; zoneId: string; tunnelId: string; dnsRecordId: string };

/** The tunnel's settings, as kept (the instance's settings, `remoteAccess`). No secret is here. */
export interface RemoteAccessSettings {
  enabled: boolean;
  /** The provider picked. Absent only before a pick: a record from before issue #968 is migrated to `ngrok`. */
  provider?: RemoteAccessProvider;
  /** The host name the admin asked for (lowercase, no scheme). Absent: the hopper picks one at the provider. */
  domain?: string;
  /** When the admin last asked for the tunnel to start again (ISO): the tunnel service starts it again when it changes. */
  restartedAt?: string;
  /** What the hopper minted for the tunnel, while it is minted. */
  provisioned?: Provisioned;
  /** What the last release could not remove at a provider: a person removes it there. */
  leftover?: string[];
}

/** The settings as the record keeps them: only the parts set. */
export const remoteAccessRecord = (s: RemoteAccessSettings): RemoteAccessSettings => ({
  enabled: s.enabled, ...(s.provider ? { provider: s.provider } : {}), ...(s.domain ? { domain: s.domain } : {}),
  ...(s.restartedAt ? { restartedAt: s.restartedAt } : {}), ...(s.provisioned ? { provisioned: s.provisioned } : {}),
  ...(s.leftover?.length ? { leftover: s.leftover } : {}),
});

/** Where the tunnel is: off; on and up; on and not up yet or any more (`down`); on, and no tunnel service asks for it. */
export type RemoteAccessState = 'off' | 'up' | 'down' | 'no-service';

export interface RemoteAccessStatus {
  state: RemoteAccessState;
  /** The public URL while the tunnel is up. */
  url?: string;
  /** Why it is not up: the tunnel agent's last error, or the tunnel watch's reason. Never a secret. */
  error?: string;
  /** When the provider's tunnel service last asked for its settings (ISO); absent: not since this start. */
  serviceSeenAt?: string;
}

/** A credential kept: who set it, when, its last 4 characters. Never its value. */
export interface CredentialMeta { setBy: string; setAt: string; last4?: string }

/** The URLs an agent calls through the tunnel: the copy-out panel shows each one. */
export interface RemoteAccessLinks {
  /** The public URL. */
  url: string;
  /** The API's base. */
  api: string;
  /** Where an agent exchanges its sign-in for an API token. */
  apiToken: string;
  /** Where a grant's agent trades its refresh token. */
  tokenRefresh: string;
}

/** Settings → Remote access (GET /api/remote-access): the settings, the credentials' metadata, never a value; the status. */
export interface RemoteAccessView {
  enabled: boolean;
  provider?: RemoteAccessProvider;
  /** The host name the admin asked for. */
  domain?: string;
  restartedAt?: string;
  /** The public URL the tunnel answers at, while one is minted. */
  url?: string;
  /** The URLs an agent calls, while the tunnel is on. */
  links?: RemoteAccessLinks;
  /** The credential kept for each provider. */
  credentials: Partial<Record<RemoteAccessProvider, CredentialMeta>>;
  /** What is minted now: the provider and the host name. */
  provisioned?: { provider: RemoteAccessProvider; domain: string };
  /** What the last release could not remove: remove it at the provider. */
  leftover?: string[];
  /** Whether this hopper has tunnel services (the compose stack's, which gives it HOPPER_TUNNEL_KEY). */
  service: boolean;
  status: RemoteAccessStatus;
  /** Why no credential can be kept or opened now (no master key). */
  problem?: string;
}

/**
 * A change from the UI or the API: each part left out keeps its value. `credential` is the provider's (the one in the
 * change, else the one picked); `null` removes it. `domain: null` lets the hopper pick the host name. `restart` starts the
 * tunnel again.
 */
export interface RemoteAccessChange {
  enabled?: boolean;
  provider?: RemoteAccessProvider;
  credential?: string | null;
  domain?: string | null;
  restart?: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host name as kept (trimmed, lowercase, a scheme or a slash at the end dropped), or why it is not one. */
export function domainOf(input: string): { domain: string } | { error: string } {
  const d = input.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (d.length === 0 || d.length > 253) return { error: 'the domain must be 1 to 253 characters' };
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { error: `${input.trim()} is no domain name: give a host name, such as hopper.example.com` };
  if (d === 'localhost' || labels.at(-1) === 'localhost') return { error: 'the domain must be a public one, never localhost' };
  return { domain: d };
}

/** The shape of each provider's credential: letters, digits, `_` and `-` (a tunnel service never sees it). */
export const CREDENTIAL: Record<RemoteAccessProvider, RegExp> = {
  cloudflare: /^[A-Za-z0-9_-]{30,200}$/,
  ngrok: /^[A-Za-z0-9_]{20,200}$/,
};

/** What each provider's credential is, and where a person makes it. */
export const CREDENTIAL_HELP: Record<RemoteAccessProvider, { name: string; where: string; needs: string }> = {
  cloudflare: {
    name: 'API token',
    where: 'https://dash.cloudflare.com/profile/api-tokens',
    needs: 'Account → Cloudflare Tunnel → Edit, and Zone → DNS → Edit on the zone the hopper\'s host name is in',
  },
  ngrok: {
    name: 'API key',
    where: 'https://dashboard.ngrok.com/api-keys',
    needs: 'an API key of the ngrok account; the account has a domain, or can reserve one',
  },
};

/** An ngrok authtoken (minted, or given by hand before issue #968): the tunnel service passes it in its environment, never quoted. */
export const AUTHTOKEN = /^[A-Za-z0-9_]{20,200}$/;

/** The public URL of a host name. */
export const tunnelUrlOf = (domain: string): string => `https://${domain}`;

/** The URLs an agent calls at a public URL. */
export const linksOf = (url: string): RemoteAccessLinks => ({ url, api: `${url}/api/`, apiToken: `${url}/ui/auth/api-token`, tokenRefresh: `${url}/ui/auth/token/refresh` });

/** The two tunnel services: the compose service `tunnel` runs ngrok, `cloudflared` runs Cloudflare's agent. */
export const AGENTS = { ngrok: 'ngrok', cloudflare: 'cloudflared' } as const satisfies Record<RemoteAccessProvider, string>;

/** What a tunnel service may report of its agent at each ask: running, stopped, or the code of the error it stopped with. */
export const AGENT_REPORT: Record<RemoteAccessProvider, RegExp> = {
  ngrok: /^(running|stopped|exited|ERR_NGROK_\d{1,5})$/,
  cloudflare: /^(running|stopped|exited)$/,
};

/**
 * The paths the tunnel lets through (issue #795): the API, and the two token routes an agent signs in with. Never the UI,
 * its sign-in pages, the installer, the event stream (its session is in the query) or the tunnel service's own ask.
 */
export function throughTheTunnel(path: string): boolean {
  const p = path.split('?')[0] ?? '';
  if (p.startsWith('/api/events/stream')) return false;
  return p.startsWith('/api/') || p.startsWith('/ui/api/') || p === '/ui/auth/api-token' || p === '/ui/auth/token/refresh';
}

/** Whether a path is one of the token routes: they have their own, lower limit through the tunnel. */
export const tokenPath = (path: string): boolean => {
  const p = path.split('?')[0] ?? '';
  return p === '/ui/auth/api-token' || p === '/ui/auth/token/refresh';
};

/** Requests a minute per caller through the tunnel, and token exchanges or refreshes a minute (issue #795). */
export const TUNNEL_RATE = { requests: 120, tokens: 5 } as const;

/** The words for an error a tunnel service reports, with its page at the provider. */
export function agentErrorText(provider: RemoteAccessProvider, code: string): string {
  const service = AGENTS[provider];
  if (code === 'exited') return `${provider === 'ngrok' ? 'ngrok' : 'cloudflared'} stopped with no error code: see the tunnel service's log (podman compose logs ${service})`;
  const n = /^ERR_NGROK_(\d+)$/.exec(code)?.[1];
  if (n === undefined) return code;
  const known: Record<string, string> = {
    '105': 'ngrok refused the authtoken: it is not one. Turn remote access off and on again to mint a new one',
    '107': 'ngrok refused the authtoken: it was revoked. Turn remote access off and on again to mint a new one',
    '108': 'the authtoken is in use by another ngrok agent, and the account allows one at a time',
    '120': 'this ngrok agent is too old for the account: update the hopper\'s compose stack',
    '334': 'the domain is in use by another ngrok agent: stop the other one',
  };
  return `${known[n] ?? 'ngrok refused to start the tunnel: see its page'} (${code}, https://ngrok.com/docs/errors/err_ngrok_${n})`;
}
