// One hopper of the crash harness (issue #1954, design.md "The crash harness"): a process of its own that runs the real
// composition root (startApp, through support/app.ts's test seams) over the test's database, so the test can end it with
// SIGKILL at a kill point. The outside services are the test process's loopback fakes, named in the environment, so what
// they count outlives this process. It prints one line, `crash-host-ready { url, token }` (an admin's UI session), once it serves; on
// SIGTERM it stops as a deploy's stop does.
//
// Environment: CRASH_DB_PATH (the test app's `dbPath`, which names its schema), HOPPER_DATABASE_URL (that schema, maybe
// through a proxy), HOPPER_WORK_DIR (this host's own), CRASH_CLOUDFLARE_URL and CRASH_NGROK_URL (the providers' fakes), CRASH_MASTER_KEY (the same for every host of a test);
// HOPPER_TEST_KILL_POINT arms a kill point (src/sagas/kill-points.ts). CRASH_GITHUB_URL (issue #1959): the node:http fake
// GitHub, and the connected account's job source `github` over it; CRASH_GITHUB_CONNECT, its job repositories (comma
// separated), connects the account first, with CRASH_GITHUB_TOKEN as its token when set. With a GitHub, the host syncs once before it serves. CRASH_CLOCK_SKEW_MS puts
// this host's clock that far ahead of the real time (behind, when negative), as a machine whose clock is off: every
// `new Date()` and `Date.now()`. CRASH_JOB (`owner/name#N`): the host pulls a job of that issue that sleeps on the local
// machine, and the ready line names it and its proxy token, so the test asks the GitHub proxy as that job does.
// CRASH_PLANT (issue #1957): once it serves, the host ends with an unhandled rejection that says that value.
// CRASH_TOPOLOGY: topology discovery reads with the crash reader (test/crash/topology-reader.ts), not AWS and Kubernetes.
// CRASH_WINDOWS: a directory; Windows steps run on the crash Windows host (test/crash/windows-host.ts), which keeps what it did there.
// CRASH_PODMAN_SOCKET: need boxes start through the real Podman adapter on this socket (HOPPER_PODMAN_SOCKET), the test
// process's libpod double, so the boxes a killed host left outlive it. CRASH_DOCKER_SOCKET: the same through the real
// Docker adapter (HOPPER_DOCKER_SOCKET), a real Docker's (the cloud acceptance tests, issue #1956).
// CRASH_LANDING_URL: the landing batches' GitHub (test/crash/landing-github.ts) as the connected account's GitHub, with
// no job source: the batch runner's calls go there.
// CRASH_RECONCILE_MS: how often the item reconciler checks (issue #1891), so a test does not wait 5 minutes for a pass.
import '../support/isolate.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { lanes, startTestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';
import { crashTopologyReader } from './topology-reader.ts';
import { crashWindowsHost } from './windows-host.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`crash host: ${name} is not set`);
  return v;
};

const { CRASH_CLOUDFLARE_URL: cloudflare, CRASH_NGROK_URL: ngrok, CRASH_GITHUB_URL: github, CRASH_GITHUB_CONNECT: connect, CRASH_JOB: issue, CRASH_PODMAN_SOCKET: podman, CRASH_DOCKER_SOCKET: docker, CRASH_LANDING_URL: landing } = process.env;

// A call the fake never answers (skewed-lease.test.ts) stays in flight for the whole scenario, not the 15 s a real
// provider call waits: on a slow runner a second host's start and two of its passes take longer than that.
const HUNG_CALL_MS = 300_000;

const skew = Number(process.env.CRASH_CLOCK_SKEW_MS ?? 0);
if (skew) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length) super(...(a as [string])); else super(RealDate.now() + skew);
    }
    static override now(): number { return RealDate.now() + skew; }
  } as DateConstructor;
}

const app = await startTestApp({
  dbPath: need('CRASH_DB_PATH'),
  env: { HOPPER_DATABASE_URL: need('HOPPER_DATABASE_URL'), HOPPER_WORK_DIR: need('HOPPER_WORK_DIR'), ...(github ?? landing ? fakeGitHubEnv({ url: (github ?? landing)! }) : {}), ...(podman ? { HOPPER_PODMAN_SOCKET: podman } : {}), ...(docker ? { HOPPER_DOCKER_SOCKET: docker } : {}) },
  secrets: { HOPPER_MASTER_KEY: need('CRASH_MASTER_KEY') },
  ...(github ? { plugins: { jobSources: [githubSource()], machines: lanes(2) } } : {}),
  seams: {
    ...(cloudflare && ngrok ? { tunnelProviders: { cloudflare: cloudflareProvider({ base: cloudflare, timeoutMs: HUNG_CALL_MS }), ngrok: ngrokProvider({ base: ngrok }) } } : {}),
    ...(process.env.CRASH_TOPOLOGY ? { topologyReader: crashTopologyReader } : {}),
    ...(process.env.CRASH_WINDOWS ? { windowsStepHost: crashWindowsHost(process.env.CRASH_WINDOWS) } : {}),
    ...(process.env.CRASH_RECONCILE_MS ? { itemReconcileEveryMs: Number(process.env.CRASH_RECONCILE_MS) } : {}),
  },
});
if (connect) connectGitHub(app, connect.split(','), { token: process.env.CRASH_GITHUB_TOKEN ?? TEST_ACCOUNT_TOKEN, key: need('CRASH_MASTER_KEY') });
if (github) await app.sync();
// A sync loop of its own (the label mirror's scenarios, issue #1892): the source's own poll is an hour in tests.
const syncMs = Number(process.env.CRASH_SYNC_MS ?? 0);
if (github && syncMs) setInterval(() => { void app.sync().catch(() => undefined); }, syncMs).unref();
let job: { job: string; proxyToken: string } | undefined;
if (issue) {
  const [repo, number] = issue.split('#') as [string, string];
  const pulled = await app.pull({ op: 'sleep', ms: 600_000 }, { url: `https://github.com/${repo}/issues/${number}`, repo, number: Number(number) });
  await app.waitForStatus(pulled.id, 'running', 30_000);
  job = { job: pulled.id, proxyToken: proxyToken(app.user().store.settings.getLinkKey()!.privateKey, app.user().user.id, pulled.id) };
}
process.once('SIGTERM', () => { void app.app.stop().finally(() => process.exit(0)); });
// A planted leak (issue #1957), once the ready line is out: the secret canary scan of a host's crash output must find it.
const plant = process.env.CRASH_PLANT;
process.stdout.write(`crash-host-ready ${JSON.stringify({ url: app.url, token: await app.login(), ...job })}\n`, () => {
  if (plant) void Promise.reject(new Error(`planted ${plant}`));
});
