// The hopper side of the pickup protocol (issue #319, design.md "Pickups on agent boxes"): read every
// agent box's pickup records over ssh, as the hopper reaches the box (`ssh <box> hopper-pickup list`), and
// print what changed since the last read as timeline lines — a pickup, each state it reports, a pickup gone
// quiet (stale), a box that cannot be read. It pulls: the box sends nothing. A spike: the daemon does not
// read pickups yet; this shows the flow end to end with the boxes as they run.
//   node scripts/box-pickups.ts [--watch <seconds>] [--stale <seconds>] [box...]
// No box named: the running `hopper-box-*` containers (`HOPPER_BOX_PREFIX`), reached by their Host in
// ~/.ssh (scripts/agent-boxes.sh).
import { execFileSync, spawnSync } from 'node:child_process';
import { isEnded, parsePickupLines, type PickupEntry, type PickupRecord } from './agent-box/pickup.ts';

export type BoxRead = { box: string; records: PickupRecord[] } | { box: string; error: string };
export interface TimelineLine { at: string; box: string; issue?: string; text: string }

/** What the reader has shown: the last seq per pickup, which pickups it called stale, which boxes are unreadable. */
export type Seen = Map<string, { seq?: number; stale?: boolean; unreadable?: boolean }>;

/** The timeline lines for what changed in `reads` since `seen`, which it updates. */
export function pickupTimeline(seen: Seen, reads: readonly BoxRead[], now: number, staleAfterMs: number): TimelineLine[] {
  const lines: TimelineLine[] = [];
  const at = new Date(now).toISOString();
  for (const read of reads) {
    const boxSeen = seen.get(read.box) ?? {};
    if ('error' in read) {
      if (!boxSeen.unreadable) lines.push({ at, box: read.box, text: `${read.box} unreadable: ${read.error}` });
      seen.set(read.box, { ...boxSeen, unreadable: true });
      continue;
    }
    if (boxSeen.unreadable) lines.push({ at, box: read.box, text: `${read.box} readable again` });
    seen.set(read.box, { ...boxSeen, unreadable: false });
    for (const r of read.records) {
      const key = `${read.box} ${r.issue}`;
      const s = seen.get(key) ?? {};
      for (const e of r.history.filter((h) => h.seq > (s.seq ?? 0))) {
        lines.push({ at: e.at, box: read.box, issue: r.issue, text: `${key} ${describe(e, r)}` });
      }
      const quiet = !isEnded(r.state) && now - Date.parse(r.updatedAt) > staleAfterMs;
      if (quiet && !s.stale) lines.push({ at, box: read.box, issue: r.issue, text: `${key} stale: not heard from since ${r.updatedAt}` });
      if (!quiet && s.stale && !isEnded(r.state)) lines.push({ at, box: read.box, issue: r.issue, text: `${key} heard from again` });
      seen.set(key, { seq: r.history.at(-1)?.seq ?? s.seq, stale: quiet });
    }
  }
  return lines;
}

function describe(e: PickupEntry, r: PickupRecord): string {
  const said = e.state === 'picked-up' ? `picked up (${r.mode})`
    : e.state === 'pull-request' ? `pull request ${r.pullRequest}`
      : e.state;
  return e.note ? `${said}: ${e.note}` : said;
}

function runningBoxes(): string[] {
  const prefix = process.env.HOPPER_BOX_PREFIX ?? 'hopper-box';
  const out = execFileSync('docker', ['ps', '--filter', `name=^${prefix}-`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

function readBox(box: string): BoxRead {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', box, 'hopper-pickup list'], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return { box, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').at(-1)! };
  const { records, problems } = parsePickupLines(r.stdout);
  return problems.length ? { box, error: problems.join('; ') } : { box, records };
}

function arg(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args.splice(i, 2)[1]);
  if (!(n > 0)) throw new Error(`${name} takes a number of seconds`);
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    const watch = arg(args, '--watch');
    const stale = (arg(args, '--stale') ?? 120) * 1000;
    const boxes = args.length ? args : runningBoxes();
    if (!boxes.length) throw new Error('no agent box running (scripts/agent-boxes.sh)');
    const seen: Seen = new Map();
    const tick = () => {
      for (const l of pickupTimeline(seen, boxes.map(readBox), Date.now(), stale)) process.stdout.write(`${l.at} ${l.text}\n`);
    };
    tick();
    if (watch) setInterval(tick, watch * 1000);
  } catch (e) {
    process.stderr.write(`box-pickups: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
