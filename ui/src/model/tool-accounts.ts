// The Accounts view's model (issue #1128, design.md "Tool accounts"): how a tool account, its sign-in and its machines are written,
// and the badge. `now` is passed in: pure.
import type { ToolAccount, ToolAccountMachine, ToolLogin } from '../../../src/domain/types.ts';
import { ago } from './format.ts';
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
