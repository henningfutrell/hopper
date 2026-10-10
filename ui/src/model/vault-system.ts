// The system scope on Settings → Vault (issue #658): what each of the hopper's own secrets is for, in words, and what an
// entry of their audit trail says. Only metadata reaches the page: there is no value to show.
import type { SystemSecretAudit, SystemSecretView } from './wire.ts';

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** What the hopper keeps the secret for, in words. */
export function systemSecretTitle(s: Pick<SystemSecretView, 'name' | 'kind'>): string {
  if (s.kind === 'typesafe') return 'TypeSafe API key (Jev)';
  if (s.kind === 'artifact') return 'Artifact content URL signing key';
  if (s.kind === 'connected-account') return s.name.endsWith('.refresh-token') ? 'GitHub connection: refresh token' : 'GitHub connection: access token';
  if (s.kind === 'webhook') return 'Webhook signing secret';
  const [, realm, setting] = s.name.split('.');
  return `Sign-in realm ${realm ?? ''}: ${setting === 'bindPassword' ? 'bind password' : 'client secret'}`;
}

/** Where it is changed: each one keeps its own page. */
export function systemSecretWhere(s: Pick<SystemSecretView, 'kind'>): string {
  if (s.kind === 'typesafe') return 'Settings → Decider';
  if (s.kind === 'artifact') return 'Made by the hopper on the first artifact link';
  if (s.kind === 'connected-account') return 'Sources: renewed by the hopper';
  if (s.kind === 'webhook') return 'Settings → Webhooks';
  return 'Settings → Sign-in';
}

/** The card's line: set, its last 4 characters, who and when; how it is kept; why it cannot be opened. */
export function systemSecretLine(s: SystemSecretView): string {
  return [
    `Set${s.last4 ? ` — ends in ${s.last4}` : ''} — ${when(s.setAt)} by ${s.setBy}`,
    'sealed',
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
