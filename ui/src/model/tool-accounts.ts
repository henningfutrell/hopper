// The Accounts view's model (issue #1128, design.md "Tool accounts"): how a tool account, its sign-in and its machines are written,
// and the badge. `now` is passed in: pure.
import type { ToolAccount, ToolAccountMachine, ToolLogin } from '../../../src/domain/types.ts';
import { ago, countdown } from './format.ts';
import { serviceLabel } from './usage.ts';

export const LOGIN_LABEL: Record<ToolLogin, string> = { 'signed-in': 'signed in', 'signed-out': 'signed out', unknown: 'not known' };
export const LOGIN_TONE = { 'signed-in': 'ok', 'signed-out': 'bad', unknown: 'warn' } as const satisfies Record<ToolLogin, string>;

/** The account's heading: the service and the identity; machines signed in as nobody, or not read, say so. */
export function accountTitle(a: Pick<ToolAccount, 'service' | 'identity' | 'login'>): string {
  const tool = serviceLabel(a.service);
  if (a.identity) return `${tool} · ${a.identity}`;
  return a.login === 'signed-out' ? `${tool} · signed in as nobody` : `${tool} · sign-in not known`;
}

/** One machine's line: when its source read it and when it last ran a job. */
export function machineLine(m: Pick<ToolAccountMachine, 'readAt' | 'lastUsedAt'>, now: number): string {
  return [m.readAt ? `read ${ago(m.readAt, now)}` : 'not read yet', m.lastUsedAt ? `last used ${ago(m.lastUsedAt, now)}` : 'no job yet'].join(' · ');
}

/** The machines whose tool is signed in as nobody: the Accounts badge counts them. */
export const signedOutMachines = (accounts: readonly ToolAccount[]): number =>
  accounts.reduce((n, a) => n + a.machines.filter((m) => m.login === 'signed-out').length, 0);

/** A sign-in that ends within this time shows in Needs you (issue #1211). */
export const EXPIRY_WARNING_MS = 24 * 3600_000;

/**
 * Needs you's Accounts row (issue #1128): one line per machine whose tool is signed in as nobody, as soon as its source reads
 * it; and one per machine whose sign-in, the tool says, ends within EXPIRY_WARNING_MS of `now` (issue #1211).
 */
export function signedOutLines(accounts: readonly ToolAccount[], now: number): string[] {
  return accounts.flatMap((a) => a.machines.flatMap((m) => {
    if (m.login === 'signed-out') return [`${serviceLabel(a.service)} on ${m.label}: signed in as nobody — sign it in from Accounts`];
    const ends = m.login === 'signed-in' && m.expiresAt ? Date.parse(m.expiresAt) : NaN;
    if (Number.isNaN(ends) || ends - now > EXPIRY_WARNING_MS) return [];
    const when = ends <= now ? 'has ended' : `ends ${countdown(m.expiresAt!, now)}`;
    return [`${serviceLabel(a.service)} on ${m.label}: its sign-in ${when} — sign it in again from Accounts`];
  }));
}
