// The system scope on Vault (issue #658): what each of the hopper's own secrets is for, in words, and what an
// entry of their audit trail says. Only metadata reaches the page: there is no value to show.
import type { SystemSecretAudit, SystemSecretView } from './wire.ts';

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Remote access's system secrets (issue #968): each provider's credential, and the tunnel token the hopper minted with it. */
const REMOTE_ACCESS: Record<string, string> = {
  'cloudflare-api-token': 'Cloudflare API token', 'cloudflare-tunnel-token': 'Cloudflare tunnel token',
  'ngrok-api-key': 'ngrok API key', 'ngrok-authtoken': 'ngrok authtoken',
};

/** What the hopper keeps the secret for, in words. */
export function systemSecretTitle(s: Pick<SystemSecretView, 'name' | 'kind'>): string {
  if (s.kind === 'typesafe') return 'TypeSafe API key (Jev)';
  if (s.kind === 'artifact') return 'Artifact content URL signing key';
  if (s.kind === 'connected-account') return s.name.endsWith('.refresh-token') ? 'GitHub connection: refresh token' : 'GitHub connection: access token';
  if (s.kind === 'webhook') return 'Webhook signing secret';
  if (s.kind === 'remote-access') return `Remote access: ${REMOTE_ACCESS[s.name.slice('remote-access.'.length)] ?? s.name}`;
  if (s.kind === 'github-webhook') return 'GitHub webhook secret';
  if (s.kind === 'cloud-link') return s.name === 'cloud-link.previous-key' ? 'cloud link key before a rotation: private half' : 'cloud link key: private half';
  const [, realm, setting] = s.name.split('.');
  return `Sign-in realm ${realm ?? ''}: ${setting === 'bindPassword' ? 'bind password' : 'client secret'}`;
}

/** Where it is changed: each one keeps its own page. */
export function systemSecretWhere(s: Pick<SystemSecretView, 'kind'>): string {
  if (s.kind === 'typesafe') return 'Settings → Decider';
  if (s.kind === 'artifact') return 'Made by the hopper on the first artifact link';
  if (s.kind === 'connected-account') return 'Sources: renewed by the hopper';
  if (s.kind === 'webhook') return 'Settings → Webhooks';
  if (s.kind === 'remote-access') return 'Settings → Remote access';
  if (s.kind === 'github-webhook') return 'Settings → GitHub webhook';
  if (s.kind === 'cloud-link') return 'Settings → hopper.io';
  return 'Settings → Sign-in';
}

/**
 * Whether a person may keep it in a vault backend (issue #658, requirement 6): a user's TypeSafe key or webhook signing
 * secret, each a value a person gives. The hopper writes the others itself, and the sign-in realms' are the whole hopper's.
 */
export const mayKeepInBackend = (s: Pick<SystemSecretView, 'kind' | 'scope'>): boolean => s.scope === 'user' && (s.kind === 'typesafe' || s.kind === 'webhook');

/** The card's line: set, its last 4 characters, who and when; how it is kept; why it cannot be opened. */
export function systemSecretLine(s: SystemSecretView): string {
  return [
    `Set${s.last4 ? ` — ends in ${s.last4}` : ''} — ${when(s.setAt)} by ${s.setBy}`,
    s.backend ? `kept in vault backend ${s.backend.name} at ${s.backend.reference}, held in memory only` : 'sealed',
    s.scope === 'instance' ? 'the whole hopper' : undefined,
  ].filter(Boolean).join(' · ');
}

const VERB: Record<string, string> = {
  'vault.secret_set': 'set', 'vault.secret_removed': 'removed', 'vault.secret_read': 'read by the hopper',
  'vault.secret_migrated': 'moved into the vault', 'vault.refused': 'refused to a job',
};

/** One audit entry as a line: when, what happened to which secret, by whom. Never a value. */
export function auditLine(e: SystemSecretAudit): string {
  const what = e.type === 'vault.secret_set' && e.detail ? e.detail : VERB[e.type] ?? e.type;
  const extra = e.type === 'vault.secret_read' && e.detail ? ` (${e.detail})` : e.type === 'vault.refused' && e.detail ? ` — ${e.detail}` : '';
  return `${when(e.at)} · ${e.name} · ${what}${extra}${e.by && e.type !== 'vault.secret_read' ? ` · ${e.by}` : ''}`;
}
