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
import '../support/isolate.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { lanes, startTestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';
import { crashTopologyReader } from './topology-reader.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`crash host: ${name} is not set`);
  return v;
};

const { CRASH_CLOUDFLARE_URL: cloudflare, CRASH_NGROK_URL: ngrok, CRASH_GITHUB_URL: github, CRASH_GITHUB_CONNECT: connect, CRASH_JOB: issue } = process.env;

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
  env: { HOPPER_DATABASE_URL: need('HOPPER_DATABASE_URL'), HOPPER_WORK_DIR: need('HOPPER_WORK_DIR'), ...(github ? fakeGitHubEnv({ url: github }) : {}) },
  secrets: { HOPPER_MASTER_KEY: need('CRASH_MASTER_KEY') },
  ...(github ? { plugins: { jobSources: [githubSource()], machines: lanes(2) } } : {}),
  seams: {
    ...(cloudflare && ngrok ? { tunnelProviders: { cloudflare: cloudflareProvider({ base: cloudflare }), ngrok: ngrokProvider({ base: ngrok }) } } : {}),
    ...(process.env.CRASH_TOPOLOGY ? { topologyReader: crashTopologyReader } : {}),
  },
});
if (connect) connectGitHub(app, connect.split(','), { token: process.env.CRASH_GITHUB_TOKEN ?? TEST_ACCOUNT_TOKEN, key: need('CRASH_MASTER_KEY') });
if (github) await app.sync();
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
