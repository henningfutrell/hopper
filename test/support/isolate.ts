// Vitest setup, run in every worker before any test file: tests never read the owner's real
// config and never send a request off this machine.
// - HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME point at a fresh temp dir, so every
//   `~/` default (grokbot-webhook.env, webhooks.yaml, plugins.yaml, github-app.json, the db)
//   resolves to an empty throwaway dir, and child processes inherit the same.
//   Exception: JOB_HOPPER_REAL_HERDR=1 keeps HOME, because Claude in a real herdr pane needs
//   the real login; the fetch guard below still applies.
// - fetch() to anything but a loopback host rejects, so a webhook can never reach a real URL.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.JOB_HOPPER_REAL_HERDR !== '1') {
  const home = mkdtempSync(join(tmpdir(), 'jh-test-home-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.XDG_DATA_HOME = join(home, '.local/share');
  process.env.XDG_STATE_HOME = join(home, '.local/state');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new Error(`test isolation: refused non-loopback request to ${url.origin}`));
  }
  return realFetch(input, init);
};
