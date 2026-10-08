// A busy demo hopper for the screenshots (issue #353): the real composition root, started as the
// integration tests start it (test/support/app.ts), over doubles at every seam — the github-account job
// source over the fake GitHub with a connected account, the scripted test executor, fake escalation levels,
// this machine and three attached ones whose probe always answers online, and a plan's usage (doubles.ts). Nothing leaves
// this machine and nothing of it shows: see doubles.ts `seal`. Attached machines run only the scripted
// executor, so no part ever opens an ssh connection.
// Example data only (the repo is public): every name, repository and login below is made up.
//
// History: the lane timeline and the throughput chart need an hour of ended jobs, and a screenshot run
// should not take an hour. So while it warms up, this process's clock runs `speed` times faster and
// starts `speed - 1` warm-ups in the past; it meets the wall clock as the warm-up ends and runs at
// normal speed after. Every time the daemon records comes from that clock; the timers do not, so a
// job that sleeps 3 s of wall time ran two minutes by the record (at the default 40×).
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import type { UsageSample } from '../../src/domain/usage-history.ts';
import { connectGitHub, githubSource } from '../../test/support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../../test/support/app.ts';
import { demoLevels, demoUsage, seal, warpClock } from './doubles.ts';

const ORG = 'example-org';
const REPOS = ['web-shop', 'api-gateway', 'mobile-app', 'docs-site'];

/** One issue a job comes from. `op` is the scripted executor's (test/support/scripted-executor.ts). */
interface Issue { repo: string; number: number; title: string; op: Record<string, unknown>; priority?: number }

const sleep = (ms: number, progress = [0.2, 0.45]) => ({ op: 'sleep', ms, progress });

/** Ended within the warm-up: the timeline's history and the Ended panel. */
const HISTORY: Issue[] = [
  { repo: 'web-shop', number: 211, title: 'Cart total ignores a discount code after a page reload', op: sleep(2500) },
  { repo: 'api-gateway', number: 88, title: 'Return 429 with a Retry-After header when a client is throttled', op: sleep(3500) },
  { repo: 'docs-site', number: 34, title: 'Fix broken links in the getting started guide', op: sleep(1500) },
  { repo: 'mobile-app', number: 57, title: 'Dark mode: settings screen keeps light colours', op: sleep(3000) },
  { repo: 'web-shop', number: 214, title: 'Product images load at full size on the list page', op: sleep(2800) },
  { repo: 'api-gateway', number: 91, title: 'Health check reports ready before the cache is warm', op: { op: 'fail', ms: 2200, message: 'tests failed: 2 of 148 (cache warm-up timing)' } },
  { repo: 'docs-site', number: 36, title: 'Add a page on rotating API keys', op: sleep(2000) },
  { repo: 'mobile-app', number: 59, title: 'Crash when the camera permission is denied', op: sleep(3800) },
  { repo: 'web-shop', number: 219, title: 'Search suggestions show out-of-stock items first', op: sleep(2600) },
  { repo: 'api-gateway', number: 93, title: 'Log the request id on every error response', op: sleep(1800) },
  { repo: 'docs-site', number: 38, title: 'Document the webhook retry schedule', op: { op: 'fail', ms: 1200, message: 'the docs build failed: unknown shortcode "callout"' } },
  { repo: 'mobile-app', number: 61, title: 'Offline banner stays after the connection comes back', op: sleep(2400) },
  { repo: 'web-shop', number: 223, title: 'Checkout button double-submits on slow networks', op: sleep(3200) },
];

/**
 * Still running, waiting or asking when the screenshots are taken. They arrive at 70 % of the warm-up;
 * the lanes are filmed from its end, so the short ones (wall time) finish on film and waiting jobs take
 * their lanes.
 */
const run = (ms: number) => sleep(ms, []);
const LIVE: Issue[] = [
  { repo: 'web-shop', number: 231, title: 'Migrate session storage from cookies to the database', priority: 70,
    op: { op: 'ask', ms: 1500, message: 'This migration drops the old sessions table, which is risky: signed-in shoppers are logged out once. Run it now, or add a grace period that reads both stores first?' } },
  { repo: 'api-gateway', number: 97, title: 'Add per-route timeouts to the proxy', op: run(40_000) },
  { repo: 'mobile-app', number: 64, title: 'Push notifications arrive twice on Android 15', op: run(600_000) },
  { repo: 'docs-site', number: 41, title: 'Rewrite the deployment guide for the new CLI', op: run(55_000) },
  { repo: 'web-shop', number: 233, title: 'Paginate the order history page', op: run(600_000) },
  { repo: 'api-gateway', number: 99, title: 'Decide which TLS versions the gateway accepts',
    op: { op: 'ask', ms: 800, message: 'I am unsure whether TLS 1.1 clients still matter here. Keep accepting them?' } },
  { repo: 'mobile-app', number: 66, title: 'Show the app version on the about screen', op: run(70_000) },
  { repo: 'web-shop', number: 236, title: 'Email receipts show the wrong currency symbol', op: run(600_000) },
  { repo: 'docs-site', number: 43, title: 'Add screenshots to the onboarding tutorial', op: run(600_000) },
  { repo: 'api-gateway', number: 102, title: 'Cache the JWKS document for an hour', op: run(85_000) },
  { repo: 'mobile-app', number: 68, title: 'Swipe to delete on the saved items list', op: run(600_000) },
  { repo: 'web-shop', number: 238, title: 'Wishlist count is off by one after removing an item', op: run(600_000) },
  { repo: 'docs-site', number: 45, title: 'Explain the rate limits on the pricing page', op: run(600_000) },
  { repo: 'api-gateway', number: 104, title: 'Reject requests with duplicate idempotency keys', op: run(600_000) },
  { repo: 'mobile-app', number: 71, title: 'Keep the scroll position when returning to the feed', op: run(600_000) },
  { repo: 'web-shop', number: 241, title: 'Add an aria-label to the cart icon button', op: run(600_000) },
  { repo: 'docs-site', number: 47, title: 'Translate the quick start into Spanish', op: run(600_000) },
  { repo: 'web-shop', number: 246, title: 'Lazy-load the reviews section', op: run(600_000) },
  { repo: 'api-gateway', number: 108, title: 'Add a request size limit to file uploads', op: run(600_000) },
  { repo: 'docs-site', number: 49, title: 'Document the new export formats', op: run(600_000) },
  { repo: 'web-shop', number: 248, title: 'Show delivery estimates on the product page', op: run(600_000) },
];

/** Arrive once the queue gate is set to review: held until the owner accepts them. */
const HELD: Issue[] = [
  { repo: 'api-gateway', number: 110, title: 'Upgrade the HTTP client to the next major version', op: run(600_000) },
  { repo: 'mobile-app', number: 73, title: 'Prefetch images on the product detail screen', op: run(600_000) },
  { repo: 'web-shop', number: 251, title: 'Remove the unused coupon service', op: run(600_000) },
];

const attached = (name: string, lanes: number) => ({
  name, plugin: 'ssh', options: { ssh: `dev@${name}`, herdr: false, lanes, executors: ['scripted'] },
});
const MACHINES = [
  { name: 'local', plugin: 'local', options: { lanes: 2, executors: ['scripted'] } },
  attached('workstation', 3), attached('build-box', 3), attached('laptop', 1),
];

/** Settings → Routing: the rules every new job is matched against. */
const ROUTING = [
  { name: 'mobile builds on the workstation', match: { repo: `${ORG}/mobile-app` }, set: { machine: 'workstation' } },
  { name: 'urgent first', match: { label: 'hopper:high' }, set: { priority: 80 } },
  { name: 'docs are low priority', match: { repo: `${ORG}/docs-site` }, set: { priority: 30 } },
];

export interface Demo { app: TestApp; url: string; stop(): Promise<void> }

const fullName = (i: Issue): string => `${ORG}/${i.repo}`;

/** Open each issue on the fake GitHub, labelled and assigned, then sync: each becomes a job. */
async function offer(a: TestApp, github: FakeGitHub, issues: Issue[]): Promise<void> {
  for (const i of issues) {
    const repo = fullName(i);
    // The fake numbers a repo's issues 1, 2, …: closed ones fill up to the issue's own number.
    if (i.number <= countIn(repo)) throw new Error(`demo: ${repo}#${i.number} comes after #${countIn(repo)}: number each repo's issues upward`);
    for (let n = countIn(repo) + 1; n < i.number; n++) github.closeIssue(repo, github.createIssue({ repo }).number);
    counts.set(repo, i.number);
    github.createIssue({
      repo, title: i.title, author: 'example-dev', labels: i.priority ? ['hopper', 'hopper:high'] : ['hopper'],
      body: `${JSON.stringify(i.op)}\n\n${i.title}.`,
    });
  }
  await a.user().sources.syncNow('github');
}

/** How many issues each repo of the fake GitHub has. */
const counts = new Map<string, number>();
const countIn = (repo: string): number => counts.get(repo) ?? 0;

/**
 * Usage samples for the past week: one plan's account read on two machines (one line on the usage graph) and a
 * second account on a third, each session window filling and resetting every five hours, and a week window.
 */
function usageHistory(now: number): UsageSample[] {
  const samples: UsageSample[] = [];
  const readers = [
    // The live usage source (doubles.ts) reads as `claude-plan` too, naming no account: its samples join this line.
    { source: 'claude-plan', account: 'dev@example.com', offset: 0, scale: 1 },
    { source: 'claude-plan-build', machineId: 'build-1', account: 'dev@example.com', offset: 5 * 60_000, scale: 1 },
    { source: 'claude-plan-gpu', machineId: 'gpu-1', account: 'research@example.com', offset: 0, scale: 0.6 },
  ];
  const week = 7 * 24 * 3_600_000;
  for (const r of readers) {
    for (let t = now - week + r.offset; t < now; t += 15 * 60_000) {
      const hour = new Date(t).getUTCHours();
      const busy = hour >= 7 && hour <= 22 ? 1 : 0.25;
      const phase = ((t / 3_600_000) % 5) / 5;
      const at = new Date(t).toISOString();
      const base = { source: r.source, ...(r.machineId ? { machineId: r.machineId } : {}), account: r.account, limit: 100, unit: '%', at };
      samples.push({ ...base, window: 'session', used: Math.round((5 + 85 * phase * busy) * r.scale), resetsAt: new Date(t + (1 - phase) * 5 * 3_600_000).toISOString() });
      samples.push({ ...base, window: 'week', used: Math.round(((t - (now - week)) / week) * 70 * r.scale) });
    }
  }
  return samples;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the demo and drive it into the busy state; `warmupMs` of wall time becomes `speed` × as much history. */
export async function startDemo(o: { warmupMs?: number; speed?: number; log?: (s: string) => void } = {}): Promise<Demo> {
  const warmupMs = o.warmupMs ?? 90_000;
  const log = o.log ?? (() => {});
  seal({ login: 'example-dev', org: ORG, repos: REPOS });
  const clock = warpClock(o.speed ?? 40, warmupMs);
  const usage = demoUsage({ now: () => new Date() });
  const db = tempDbPath();
  const github = createFakeGitHub({ login: 'example-dev' });
  const a = await startTestApp({
    dbPath: db.dbPath,
    realRouter: true,
    plugins: { machines: MACHINES, routing: ROUTING, jobSources: [githubSource({ executor: 'scripted' })] },
    seams: {
      github, levels: demoLevels(), perUser: () => ({ fakeUsage: usage, sources: [] }),
      machineProbe: () => Promise.resolve({ online: true, home: '/home/dev' }),
    },
  });
  // A finished job ships: its pull request is merged, which closes its issue.
  a.scripted.ships((job) => {
    const at = new Date().toISOString();
    github.closeByPullRequest(job.source!.repo!, job.source!.number!, { createdAt: at, mergedAt: at });
  });
  connectGitHub(a, REPOS.map((r) => `${ORG}/${r}`), { login: 'example-dev' });
  a.user().store.usageHistory.record(usageHistory(Date.now()));
  usage.setAll(18);
  log(`demo hopper at ${a.url}; warming up for ${Math.round(warmupMs / 1000)} s`);

  const started = performance.now();
  // Two or three at a time, so the history spreads over several lanes.
  const batches = [[0, 3], [3, 5], [5, 8], [8, 10], [10, 13]].map(([from, to]) => HISTORY.slice(from, to));
  for (const [n, batch] of batches.entries()) {
    await offer(a, github, batch);
    usage.setAll(18 + 6 * n);
    await pause(warmupMs * 0.7 / batches.length);
  }
  await offer(a, github, LIVE);
  await pause(Math.max(0, warmupMs - (performance.now() - started)));
  clock.settle();
  const token = await a.login();
  const gate = await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token });
  if (gate.status !== 200) throw new Error(`demo: the queue gate was not set: ${gate.status} ${JSON.stringify(gate.body)}`);
  await offer(a, github, HELD);
  usage.setAll(46);
  log('demo hopper busy');
  return {
    app: a, url: a.url,
    async stop() {
      await a.stop().catch((e: unknown) => console.error(`demo: ${String(e)}`));
      db.cleanup();
    },
  };
}
