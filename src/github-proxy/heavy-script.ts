// `hopper-heavy` (issue #2622 part 3, design.md "The heavy-step gate"): what a job runs a heavy step through — a JVM build,
// a package install, a Playwright browser install or test run, an image build. It asks the hopper for a slot (`POST
// /job/heavy`, src/http/job-heavy.ts), waits while the hopper says why it must, runs the command with the slot renewed, and
// lets the slot go when the command ends. A hopper it cannot ask, or one that says no, never stops the command: it runs.
// Part 5: a renew answer that says `pause` stops the command's process group (SIGSTOP) until a renew answers none (SIGCONT).
// Kept in the job's credentials dir beside its proxy token, run as `sh "$HOPPER_HEAVY" COMMAND [ARGS...]`, and by the
// shims on the job's PATH (src/domain/heavy-steps.ts): a POSIX sh line that runs the client, a Node module with no
// dependency, as `hopper-requirements`'s. Its token goes in a header, never on a command line.

export const HEAVY_SCRIPT_VARIABLE = 'HOPPER_HEAVY';

/** The files under the job's credentials dir. */
export const HEAVY_SCRIPT_FILE = 'hopper/heavy';
export const HEAVY_CLIENT_FILE = 'hopper/heavy.mjs';

/** The script: the command as it is inside a heavy step or with no node, else Node runs the client beside it. */
export const HEAVY_SCRIPT = `#!/bin/sh
# hopper-heavy — a heavy step (a JVM build, an install, a browser install or test, an image build), run when the machine's memory holds it (issue #2622). Written by the hopper at each job start.
#   sh "$HOPPER_HEAVY" COMMAND [ARGS...]
if [ $# -gt 0 ] && [ -n "\${HOPPER_HEAVY_HELD:-}" ]; then exec "$@"; fi
if ! command -v node >/dev/null 2>&1; then [ $# -gt 0 ] || { echo 'usage: sh "$HOPPER_HEAVY" COMMAND [ARGS...]' >&2; exit 2; }; echo "hopper-heavy: no slot (no node here): $1 runs now" >&2; exec "$@"; fi
exec node "$(dirname "$0")/heavy.mjs" "$@"
`;

/** The client: a Node module with no dependency. No backtick and no dollar-brace in it: it is kept in a template string. */
export const HEAVY_CLIENT = String.raw`// hopper-heavy (issue #2622): a heavy step, run when the machine's memory holds it.
//   sh "$HOPPER_HEAVY" COMMAND [ARGS...]   ask the hopper for a slot, wait while it says why, then run the command;
//                                          its exit code is the command's. A hopper that cannot be asked: it runs now.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const say = (line) => process.stderr.write('hopper-heavy: ' + line + '\n');
const argv = process.argv.slice(2);
if (!argv.length) { say('usage: sh "$HOPPER_HEAVY" COMMAND [ARGS...]'); process.exit(2); }
const name = argv[0].slice(argv[0].lastIndexOf('/') + 1);
const base = process.env.HOPPER_URL;
const tokenFile = process.env.HOPPER_TOKEN_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(body) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  let res;
  try {
    res = await fetch(new URL('/job/heavy', base), {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error('the hopper cannot be reached: ' + e.message);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().replace(/^no: /, 'the hopper said no: ') || 'the hopper answered ' + res.status);
  return JSON.parse(text);
}

let slot;
if (!base || !tokenFile) say('no slot (HOPPER_URL or HOPPER_TOKEN_FILE is not set): ' + name + ' runs now');
else {
  let said = '';
  for (;;) {
    let a;
    try { a = await ask({ op: 'take', argv: argv.slice(0, 16) }); } catch (e) { say('no slot (' + e.message + '): ' + name + ' runs now'); break; }
    if (a.wait) {
      if (a.wait !== said) say(name + ' waits: ' + a.wait);
      said = a.wait;
      await sleep((a.retryS || 5) * 1000);
      continue;
    }
    if (a.slot) { slot = a; if (said) say(name + ' runs: the memory holds it now'); }
    break;
  }
}

// The command runs in a process group of its own, so a pause stops all of it: a build's JVM, not only its wrapper script.
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true, env: { ...process.env, HOPPER_HEAVY_HELD: '1' } });
const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* it ended */ } };
let paused = false;
const renew = slot ? setInterval(() => {
  ask({ op: 'renew', slot: slot.slot }).then((a) => {
    if (a.pause && !paused) { paused = true; group('SIGSTOP'); say(name + ' paused: ' + a.pause); }
    else if (!a.pause && paused) { paused = false; group('SIGCONT'); say(name + ' runs again: the memory pressure cleared'); }
  }, () => {});
}, (slot.renewS || 10) * 1000) : undefined;
const release = async () => {
  if (renew) clearInterval(renew);
  if (slot) await ask({ op: 'release', slot: slot.slot }).catch(() => {});
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { group(sig); if (paused) group('SIGCONT'); });
child.on('error', async (e) => { say(name + ': ' + e.message); await release(); process.exit(127); });
child.on('exit', async (code, signal) => {
  await release();
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  process.exit(code ?? 1);
});
`;
