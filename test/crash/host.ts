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
// separated), connects the account first. With a GitHub, the host syncs once before it serves.
import '../support/isolate.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { startTestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`crash host: ${name} is not set`);
  return v;
};

const { CRASH_CLOUDFLARE_URL: cloudflare, CRASH_NGROK_URL: ngrok, CRASH_GITHUB_URL: github, CRASH_GITHUB_CONNECT: connect } = process.env;
const app = await startTestApp({
  dbPath: need('CRASH_DB_PATH'),
  env: { HOPPER_DATABASE_URL: need('HOPPER_DATABASE_URL'), HOPPER_WORK_DIR: need('HOPPER_WORK_DIR'), ...(github ? fakeGitHubEnv({ url: github }) : {}) },
  secrets: { HOPPER_MASTER_KEY: need('CRASH_MASTER_KEY') },
  ...(github ? { plugins: { jobSources: [githubSource()] } } : {}),
  seams: {
    ...(cloudflare && ngrok ? { tunnelProviders: { cloudflare: cloudflareProvider({ base: cloudflare }), ngrok: ngrokProvider({ base: ngrok }) } } : {}),
  },
});
if (connect) connectGitHub(app, connect.split(','), { token: TEST_ACCOUNT_TOKEN, key: need('CRASH_MASTER_KEY') });
if (github) await app.sync();
process.once('SIGTERM', () => { void app.app.stop().finally(() => process.exit(0)); });
process.stdout.write(`crash-host-ready ${JSON.stringify({ url: app.url, token: await app.login() })}\n`);
