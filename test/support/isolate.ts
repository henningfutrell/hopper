// Vitest setup, run in every worker before any test file: tests never read the owner's real
// config and never send a request off this machine.
// - HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME point at a fresh temp dir, so every
//   `~/` default (grokbot-webhook.env, plugins.yaml, github-app.json, the db)
//   resolves to an empty throwaway dir, and child processes inherit the same.
//   Exception: HOPPER_REAL_HERDR=1 keeps HOME, because Claude in a real herdr pane needs
//   the real login; the fetch guard below still applies.
// - `claude` on PATH is a guard that answers `--version` (detection) and refuses everything else,
//   so a built-in instance left at its default `bin` (claude-plan's background `/usage` read,
//   issue #18) never runs the real CLI. A test that wants claude names a fake as `bin`; the acceptance tests
//   (test/acceptance/, issue #1958) name the real one, found past this guard, and point it at the fake model server.
// - XDG_RUNTIME_DIR is a throwaway dir in the real one (isolateRuntimeDir below, issue #1295).
// - fetch() to anything but a loopback host rejects, so a webhook can never reach a real URL.
// - KUBERNETES_SERVICE_HOST is unset, so a test run in a pod (a lane pod's job) reads as a host install does; a test
//   of a cluster install sets it in the environment it passes (issue #1289).
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const CLAUDE_GUARD = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0 (hopper test isolation)"; exit 0; fi
echo "test isolation: the real claude is never run in tests" >&2
exit 1
`;

if (process.env.HOPPER_REAL_HERDR !== '1') {
  const home = mkdtempSync(join(tmpdir(), 'jh-test-home-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.XDG_DATA_HOME = join(home, '.local/share');
  process.env.XDG_STATE_HOME = join(home, '.local/state');
  const guards = join(home, '.isolation-bin');
  mkdirSync(guards, { mode: 0o700 });
  writeFileSync(join(guards, 'claude'), CLAUDE_GUARD, { mode: 0o755 });
  process.env.PATH = `${guards}${delimiter}${process.env.PATH ?? ''}`;
  isolateRuntimeDir();
}

/**
 * XDG_RUNTIME_DIR a throwaway dir in the user's own (issue #1295), so a job's container runtime a test sets up lands there,
 * never in the user's runtime dir, and goes when the worker ends. In the same tmpfs, the user's bus and systemd's private
 * socket are hard links in it, so `systemd-run --user` and `systemctl --user` still answer. No runtime dir: as it is.
 */
function isolateRuntimeDir(): void {
  const run = process.env.XDG_RUNTIME_DIR;
  if (!run || !existsSync(run)) return;
  let own: string;
  try { own = mkdtempSync(join(run, 'jh-test-run-')); } catch { return; }
  mkdirSync(join(own, 'systemd'));
  for (const socket of ['bus', join('systemd', 'private')]) {
    try { linkSync(join(run, socket), join(own, socket)); } catch { /* no such socket here: nothing to reach */ }
  }
  process.env.XDG_RUNTIME_DIR = own;
  process.on('exit', () => rmSync(own, { recursive: true, force: true }));
}

delete process.env.KUBERNETES_SERVICE_HOST;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new Error(`test isolation: refused non-loopback request to ${url.origin}`));
  }
  return realFetch(input, init);
};
