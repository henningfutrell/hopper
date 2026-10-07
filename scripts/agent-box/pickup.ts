// The box side of the pickup protocol (issue #319, design.md "Pickups on agent boxes"): an operator-led
// session on an agent box reports the issue it picked up and how it stands, as one **pickup record** per
// issue in the box's pickup dir (`HOPPER_PICKUP_DIR`, else ~/.hopper/pickups). Nothing is sent: the hopper
// side reads the records over ssh (`hopper-pickup list`, scripts/box-pickups.ts), as it reads herdr.
// No imports but node's own: the box runs this file with its node, no install (`/usr/local/bin/hopper-pickup`).
//   hopper-pickup pickup <issue url> [--work-tree <path>] [--branch <name>] [--note <text>]
//   hopper-pickup status <issue url> <state> [--pull-request <url>] [--branch <name>] [--note <text>]
//   hopper-pickup beat <issue url>
//   hopper-pickup list
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A pickup's states after `picked-up`. `finished` and `released` end it. */
export const PICKUP_STATES = ['working', 'waiting', 'blocked', 'pull-request', 'finished', 'released'] as const;
export type PickupState = 'picked-up' | (typeof PICKUP_STATES)[number];
const ENDED: readonly PickupState[] = ['finished', 'released'];
const HISTORY_KEPT = 50;

export interface PickupEntry { seq: number; state: PickupState; at: string; note?: string }

export interface PickupRecord {
  v: 1;
  issue: string;
  mode: 'operator-led';
  state: PickupState;
  pickedUpAt: string;
  /** The last word from the box: any change, or a heartbeat. */
  updatedAt: string;
  workTree?: string;
  branch?: string;
  pullRequest?: string;
  history: PickupEntry[];
}

export type PickupCommand =
  | { kind: 'pickup'; issue: string; workTree?: string; branch?: string; note?: string }
  | { kind: 'status'; state: Exclude<PickupState, 'picked-up'>; pullRequest?: string; branch?: string; note?: string }
  | { kind: 'beat' };

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)$/;

/** The file of an issue's pickup record in the pickup dir. */
export function pickupFile(issue: string): string {
  const m = ISSUE_URL.exec(issue);
  if (!m) throw new Error(`${issue} is not a GitHub issue url (https://github.com/<owner>/<repo>/issues/<n>)`);
  return `${m[1]}_${m[2]}_${m[3]}.json`;
}

export function isEnded(state: PickupState): boolean {
  return ENDED.includes(state);
}

/** The record after `cmd` at `now`. Throws when the command does not fit the record. */
export function applyPickup(prev: PickupRecord | undefined, cmd: PickupCommand, now: string): PickupRecord {
  if (cmd.kind === 'pickup') {
    pickupFile(cmd.issue);
    if (prev && !isEnded(prev.state)) throw new Error(`${cmd.issue} is already picked up (${prev.state})`);
    const seq = (prev?.history.at(-1)?.seq ?? 0) + 1;
    return {
      v: 1, issue: cmd.issue, mode: 'operator-led', state: 'picked-up', pickedUpAt: now, updatedAt: now,
      ...(cmd.workTree ? { workTree: cmd.workTree } : {}), ...(cmd.branch ? { branch: cmd.branch } : {}),
      history: keep([...(prev?.history ?? []), entry(seq, 'picked-up', now, cmd.note)]),
    };
  }
  if (!prev) throw new Error('nothing picked up');
  if (isEnded(prev.state)) throw new Error(`the pickup of ${prev.issue} ended (${prev.state}): pick it up again`);
  if (cmd.kind === 'beat') return { ...prev, updatedAt: now };
  if (cmd.state === 'pull-request' && !cmd.pullRequest) throw new Error('a pull-request state names its pull request (--pull-request <url>)');
  return {
    ...prev, state: cmd.state, updatedAt: now,
    ...(cmd.branch ? { branch: cmd.branch } : {}), ...(cmd.pullRequest ? { pullRequest: cmd.pullRequest } : {}),
    history: keep([...prev.history, entry(prev.history.at(-1)!.seq + 1, cmd.state, now, cmd.note)]),
  };
}

function entry(seq: number, state: PickupState, at: string, note: string | undefined): PickupEntry {
  return note ? { seq, state, at, note } : { seq, state, at };
}

function keep(history: PickupEntry[]): PickupEntry[] {
  return history.slice(-HISTORY_KEPT);
}

/** The records `hopper-pickup list` prints, one JSON line each, and a problem per line that is not one. */
export function parsePickupLines(text: string): { records: PickupRecord[]; problems: string[] } {
  const records: PickupRecord[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { problems.push(`line ${i + 1}: not JSON`); return; }
    if (isRecord(value)) records.push(value); else problems.push(`line ${i + 1}: not a pickup record v1`);
  });
  return { records, problems };
}

function isRecord(v: unknown): v is PickupRecord {
  const r = v as Partial<PickupRecord> | null;
  return typeof r === 'object' && r !== null && r.v === 1 && r.mode === 'operator-led' && typeof r.issue === 'string'
    && typeof r.state === 'string' && typeof r.updatedAt === 'string' && Array.isArray(r.history);
}

const USAGE = `usage: hopper-pickup pickup <issue url> [--work-tree <path>] [--branch <name>] [--note <text>]
       hopper-pickup status <issue url> <${PICKUP_STATES.join('|')}> [--pull-request <url>] [--branch <name>] [--note <text>]
       hopper-pickup beat <issue url>
       hopper-pickup list
`;

class UsageError extends Error {}

function options(args: string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!.replace(/^--/, '');
    if (!args[i]!.startsWith('--') || !allowed.includes(name) || args[i + 1] === undefined) throw new UsageError(`unexpected ${args[i]}`);
    out[name] = args[i + 1]!;
  }
  return out;
}

function command(args: string[]): { issue: string; cmd: PickupCommand } {
  const [kind, issue, ...rest] = args;
  if (!issue) throw new UsageError('name the issue');
  if (kind === 'pickup') {
    const o = options(rest, ['work-tree', 'branch', 'note']);
    return { issue, cmd: { kind, issue, workTree: o['work-tree'] ?? process.cwd(), branch: o.branch, note: o.note } };
  }
  if (kind === 'status') {
    const [state, ...more] = rest;
    if (!PICKUP_STATES.includes(state as never)) throw new UsageError(`no state ${state ?? '(none)'}`);
    const o = options(more, ['pull-request', 'branch', 'note']);
    return { issue, cmd: { kind, state: state as (typeof PICKUP_STATES)[number], pullRequest: o['pull-request'], branch: o.branch, note: o.note } };
  }
  if (kind === 'beat' && rest.length === 0) return { issue, cmd: { kind } };
  throw new UsageError(`no command ${kind ?? '(none)'}`);
}

function main(args: string[]): number {
  const dir = process.env.HOPPER_PICKUP_DIR || join(homedir(), '.hopper', 'pickups');
  try {
    if (args[0] === 'list' && args.length === 1) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* no pickups yet */ }
      for (const f of files) process.stdout.write(`${JSON.stringify(JSON.parse(readFileSync(join(dir, f), 'utf8')))}\n`);
      return 0;
    }
    const { issue, cmd } = command(args);
    const file = join(dir, pickupFile(issue));
    let prev: PickupRecord | undefined;
    try { prev = JSON.parse(readFileSync(file, 'utf8')) as PickupRecord; } catch { prev = undefined; }
    if (prev === undefined && cmd.kind !== 'pickup') throw new Error(`nothing picked up for ${issue}`);
    const next = applyPickup(prev, cmd, new Date().toISOString());
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    return 0;
  } catch (e) {
    process.stderr.write(`hopper-pickup: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) { process.stderr.write(USAGE); return 2; }
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
