// Remote access (issue #880, design.md "Remote access"): the tunnel's settings, kept by the hopper and set in the UI —
// whether it is on and the domain reserved for it at ngrok; its authtoken is a system secret of the instance's vault. The
// public URL of the tunnel follows from the domain. Pure: the shapes, the checks and the words for what the tunnel says.

/** The tunnel's settings, as kept (the instance's settings, `remoteAccess`). The authtoken is not here: it is a system secret. */
export interface RemoteAccessSettings {
  enabled: boolean;
  /** The domain reserved at ngrok (`hopper.example.ngrok.app`), lowercase, no scheme, no port. */
  domain?: string;
  /** When the admin last asked for the tunnel to start again (ISO): the tunnel service starts ngrok again when it changes. */
  restartedAt?: string;
}

/** Where the tunnel is: off; on and up; on and not up yet or any more (`down`); on, and no tunnel service asks for it. */
export type RemoteAccessState = 'off' | 'up' | 'down' | 'no-service';

export interface RemoteAccessStatus {
  state: RemoteAccessState;
  /** The public URL while the tunnel is up. */
  url?: string;
  /** Why it is not up: ngrok's last error, or the tunnel watch's reason. Never a secret. */
  error?: string;
  /** When the tunnel service last asked for its settings (ISO); absent: not since this start. */
  serviceSeenAt?: string;
}

/** Settings → Remote access (GET /api/remote-access): the settings, the authtoken's metadata, never its value; the status. */
export interface RemoteAccessView {
  enabled: boolean;
  domain?: string;
  restartedAt?: string;
  /** `https://<domain>`: the tunnel's public URL. */
  url?: string;
  /** The authtoken kept: who set it, when, its last 4 characters. Absent: none is kept. */
  authtoken?: { setBy: string; setAt: string; last4?: string };
  /** Whether this hopper has a tunnel service (the compose stack's, which gives it HOPPER_TUNNEL_KEY). */
  service: boolean;
  status: RemoteAccessStatus;
  /** Why no authtoken can be kept or opened now (no master key). */
  problem?: string;
}

/** A change from the UI or the API: each part left out keeps its value. `authtoken: null` removes the token; `restart` starts ngrok again. */
export interface RemoteAccessChange {
  enabled?: boolean;
  domain?: string | null;
  authtoken?: string | null;
  restart?: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The domain as kept (trimmed, lowercase, a scheme or a slash at the end dropped), or why it is not one. */
export function domainOf(input: string): { domain: string } | { error: string } {
  const d = input.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (d.length === 0 || d.length > 253) return { error: 'the domain must be 1 to 253 characters' };
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { error: `${input.trim()} is no domain name: give the domain reserved at ngrok, such as hopper.example.ngrok.app` };
  if (d === 'localhost' || labels.at(-1) === 'localhost') return { error: 'the domain must be a public one, never localhost' };
  return { domain: d };
}

/** An ngrok authtoken: letters, digits and underscores (the tunnel service passes it in its environment, never quoted). */
export const AUTHTOKEN = /^[A-Za-z0-9_]{20,200}$/;

/** The public URL of a domain. */
export const tunnelUrlOf = (domain: string): string => `https://${domain}`;

/** What the tunnel service may report of ngrok at each ask: running, stopped, or the code of the error it stopped with. */
export const AGENT_REPORT = /^(running|stopped|exited|ERR_NGROK_\d{1,5})$/;

/** The words for an ngrok error code the tunnel service reports, with its page at ngrok. */
export function ngrokErrorText(code: string): string {
  if (code === 'exited') return 'ngrok stopped with no error code: see the tunnel service\'s log (podman compose logs tunnel)';
  const n = /^ERR_NGROK_(\d+)$/.exec(code)?.[1];
  if (n === undefined) return code;
  const known: Record<string, string> = {
    '105': 'ngrok refused the authtoken: it is not one. Copy it again from https://dashboard.ngrok.com/get-started/your-authtoken',
    '107': 'ngrok refused the authtoken: it was revoked. Copy a new one from https://dashboard.ngrok.com/get-started/your-authtoken',
    '108': 'the authtoken is in use by another ngrok agent, and the account allows one at a time',
    '120': 'this ngrok agent is too old for the account: update the hopper\'s compose stack',
    '334': 'the domain is in use by another ngrok agent: stop the other one',
  };
  return `${known[n] ?? 'ngrok refused to start the tunnel: see its page'} (${code}, https://ngrok.com/docs/errors/err_ngrok_${n})`;
}
