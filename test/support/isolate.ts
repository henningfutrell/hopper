// Vitest setup, run in every worker before any test file: tests never read the owner's real
// config and never send a request off this machine.
// - HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME point at a fresh temp dir, so every
//   `~/` default (grokbot-webhook.env, webhooks.yaml, plugins.yaml, github-app.json, the db)
//   resolves to an empty throwaway dir, and child processes inherit the same.
//   Exception: JOB_HOPPER_REAL_HERDR=1 keeps HOME, because Claude in a real herdr pane needs
//   the real login; the fetch guard below still applies.
// - `claude` on PATH is a guard that answers `--version` (detection) and refuses everything else,
//   so a built-in instance left at its default `bin` (claude-plan's background `/usage` read,
//   issue #18) never runs the real CLI. A test that wants claude names a fake as `bin`.
// - fetch() to anything but a loopback host rejects, so a webhook can never reach a real URL.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const CLAUDE_GUARD = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0 (job-hopper test isolation)"; exit 0; fi
echo "test isolation: the real claude is never run in tests" >&2
exit 1
`;

if (process.env.JOB_HOPPER_REAL_HERDR !== '1') {
  const home = mkdtempSync(join(tmpdir(), 'jh-test-home-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.XDG_DATA_HOME = join(home, '.local/share');
  process.env.XDG_STATE_HOME = join(home, '.local/state');
  const guards = join(home, '.isolation-bin');
  mkdirSync(guards, { mode: 0o700 });
  writeFileSync(join(guards, 'claude'), CLAUDE_GUARD, { mode: 0o755 });
  process.env.PATH = `${guards}${delimiter}${process.env.PATH ?? ''}`;
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
