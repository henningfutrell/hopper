// `hopper-requirements` (issue #2555, design.md "Push requirements"): the command a job runs in its work tree before it
// pushes. It reads the commit's requirements files and its changed files against the branch's base, asks the hopper which
// requirements apply (`POST /job/requirements`, src/http/job-requirements.ts), runs their checks here, and has the hopper
// judge and record the result, which the git proxy reads at the push. `dry-run` lists what would run and runs nothing.
// Kept in the job's credentials dir beside its proxy token, run as `sh "$HOPPER_REQUIREMENTS"`: a POSIX sh line that runs
// the client, a Node module with no dependency, as `hopper-relay`'s. Its token goes in a header, never on a command line.
// A check's output stays on the job's machine: the job reads it, the hopper never gets it.

export const REQUIREMENTS_SCRIPT_VARIABLE = 'HOPPER_REQUIREMENTS';

/** The files under the job's credentials dir. */
export const REQUIREMENTS_SCRIPT_FILE = 'hopper/requirements';
export const REQUIREMENTS_CLIENT_FILE = 'hopper/requirements.mjs';

/** The script: Node runs the client beside it. */
export const REQUIREMENTS_SCRIPT = `#!/bin/sh
# hopper-requirements — a push's requirements, checked in the work tree before the push (issue #2555). Written by the hopper at each job start.
#   sh "$HOPPER_REQUIREMENTS" check|dry-run [--base BRANCH] [--repo OWNER/NAME] [--json]
# The client and its help: requirements.mjs beside this file.
command -v node >/dev/null 2>&1 || { echo 'hopper-requirements: it needs node on PATH' >&2; exit 2; }
exec node "$(dirname "$0")/requirements.mjs" "$@"
`;

/** The client: a Node module with no dependency. No backtick and no dollar-brace in it: it is kept in a template string. */
export const REQUIREMENTS_CLIENT = String.raw`// hopper-requirements (issue #2555): the push requirements of the commit checked out here, checked before a push.
//   sh "$HOPPER_REQUIREMENTS" check     run the checks of each requirement that applies; the hopper records the result,
//                                       and the git proxy takes a push of this commit only after a passing one.
//   sh "$HOPPER_REQUIREMENTS" dry-run   list the requirements that apply, the ones skipped and why, and the commands; run nothing.
//   --base BRANCH   the branch the change merges into; none: the hopper says (the pull request's, else the landing or default branch)
//   --repo O/N      the repository; none: origin's
//   --json          the hopper's answer as JSON
// A repository keeps its requirements in .hopper/requirements.yaml; one in a folder's .hopper/ holds for changes in that folder.
// A check passes when it exits 0 and each threshold holds on what it measured: it prints a line "hopper-measure NAME=NUMBER".
// Exit 0: passed (or the dry run); 1: a requirement failed, or the hopper refused; 2: a bad call.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = '.hopper/requirements.yaml';
const USAGE = 'usage: sh "$HOPPER_REQUIREMENTS" check|dry-run [--base BRANCH] [--repo OWNER/NAME] [--json]';
const say = (line) => process.stderr.write('hopper-requirements: ' + line + '\n');
const fail = (line, code) => { say(line); process.exit(code ?? 1); };
const args = process.argv.slice(2);
const op = args[0];
if (op !== 'check' && op !== 'dry-run') fail(USAGE, 2);
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const json = args.includes('--json');
for (const name of ['--base', '--repo']) if (args.includes(name) && !flag(name)) fail(name + ' needs a value. ' + USAGE, 2);
const base0 = process.env.HOPPER_URL;
const tokenFile = process.env.HOPPER_TOKEN_FILE;
if (!base0) fail('HOPPER_URL is not set: the hopper cannot be reached from here', 2);
if (!tokenFile) fail('HOPPER_TOKEN_FILE is not set', 2);

const git = (gargs, o) => {
  const r = spawnSync('git', gargs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(o ?? {}) });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
};
const must = (gargs, why) => { const r = git(gargs); if (r.code !== 0) fail(why + ': ' + (r.err || 'git exited ' + r.code)); return r.out; };

async function ask(body) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  for (let tries = 0; ; tries++) {
    let res;
    try {
      res = await fetch(new URL('/job/requirements', base0), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (tries < 4) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      fail('the hopper cannot be reached: ' + e.message);
    }
    const text = await res.text();
    const wait = Number(res.headers.get('retry-after'));
    if (res.status === 503 && wait > 0 && tries < 10) { say('the hopper is out of reach: again in ' + wait + ' s'); await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
    if (!res.ok) fail(text.trim().replace(/^no: /, 'the hopper said no: '));
    return JSON.parse(text);
  }
}

const top = must(['rev-parse', '--show-toplevel'], 'not in a git work tree').trim();
process.chdir(top);
const head = must(['rev-parse', 'HEAD'], 'no commit checked out').trim();
const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
if (!branch) fail('check out the branch you push: HEAD is detached');
let repo = flag('--repo');
if (!repo) {
  const url = must(['remote', 'get-url', 'origin'], 'no remote origin: name the repository with --repo').trim();
  repo = url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('/');
}
if (op === 'check' && git(['status', '--porcelain', '--untracked-files=no']).out.trim() !== '') fail('commit your changes first: the evaluation is of a commit, ' + head.slice(0, 12));

const requirementsFiles = {};
for (const path of must(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], 'the commit cannot be listed').split('\0')) {
  if (path === FILE || path.endsWith('/' + FILE)) requirementsFiles[path] = must(['show', 'HEAD:' + path], 'cannot read ' + path);
}
const base = flag('--base') ?? (await ask({ op: 'base', repo, branch })).base;
// The changed files: the commit against where it leaves the base, fetched first, else as this clone last saw it.
const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', 'refs/heads/' + base]).code === 0;
let start = git(['merge-base', fetched ? 'FETCH_HEAD' : 'refs/remotes/origin/' + base, 'HEAD']).out.trim();
if (!start) fail('no merge base with ' + base + ': fetch it (git fetch origin ' + base + '), or name the base with --base');
const files = must(['diff', '--name-only', '-z', '--no-renames', start, 'HEAD'], 'the changed files cannot be listed').split('\0').filter(Boolean);
const pushed = { repo, branch, base, head, files, requirementsFiles };
const { plan } = await ask({ op: 'plan', ...pushed });

const thresholds = (c) => Object.entries(c.thresholds ?? {}).map(([n, t]) => (t.min !== undefined ? n + ' >= ' + t.min : '') + (t.min !== undefined && t.max !== undefined ? ', ' : '') + (t.max !== undefined ? n + ' <= ' + t.max : '')).join(', ');
const where = (q) => (q.dir ? ' in ' + q.dir : '');
console.log(repo + ' ' + branch + ' at ' + head.slice(0, 12) + ' against ' + base + ': ' + files.length + ' changed file' + (files.length === 1 ? '' : 's'));
if (op === 'dry-run') {
  if (json) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
  for (const q of plan.matched) {
    console.log('match ' + q.id + ' (' + q.level + '): ' + q.why);
    for (const c of q.checks) console.log('  run ' + c.run + where(q) + (c.thresholds ? '  [' + thresholds(c) + ']' : ''));
  }
  for (const q of plan.skipped) console.log('skip  ' + q.id + ' (' + q.level + '): ' + q.reason);
  if (plan.matched.length + plan.skipped.length === 0) console.log('no push requirements apply');
  process.exit(0);
}

/** One check, run here: its exit code, what it measured, its output. */
const runCheck = (q, c) => new Promise((resolve) => {
  const env = { ...process.env, ...(c.env ?? {}) };
  for (const [n, t] of Object.entries(c.thresholds ?? {})) {
    if (t.min !== undefined) env['HOPPER_MIN_' + n] = String(t.min);
    if (t.max !== undefined) env['HOPPER_MAX_' + n] = String(t.max);
  }
  say('run ' + q.id + ': ' + c.run + where(q));
  const child = spawn('sh', ['-c', c.run], { cwd: join(top, q.dir ?? ''), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  child.on('error', (e) => out.push(Buffer.from(e.message + '\n')));
  child.on('close', (code, signal) => {
    const text = Buffer.concat(out).toString('utf8');
    const measured = {};
    for (const m of text.matchAll(/^hopper-measure\s+([A-Za-z][A-Za-z0-9_]*)=(-?[0-9.]+)\s*$/gm)) measured[m[1]] = Number(m[2]);
    resolve({ run: { name: c.name, exit: code ?? (signal ? 128 : 1), ...(Object.keys(measured).length ? { measured } : {}) }, text });
  });
});

const runs = [];
const outputs = {};
for (const q of plan.matched) {
  const checks = [];
  for (const c of q.checks) { const r = await runCheck(q, c); checks.push(r.run); outputs[q.id + '/' + c.name] = r.text; }
  runs.push({ id: q.id, checks });
}
const judged = await ask({ op: 'record', ...pushed, runs });
if (json) console.log(JSON.stringify(judged, null, 2));
else {
  for (const q of judged.requirements) {
    console.log(q.status.padEnd(7) + ' ' + q.id + ' (' + q.level + ')' + (q.reason ? ': ' + q.reason : ''));
    for (const c of q.checks ?? []) {
      const m = Object.entries(c.measured ?? {}).map(([n, v]) => n + '=' + v).join(', ');
      console.log('  ' + (c.passed ? 'ok  ' : 'FAIL') + ' ' + c.run + ' (exit ' + c.exit + (m ? ', ' + m : '') + ')' + (c.problem ? ': ' + c.problem : ''));
      if (!c.passed) {
        const lines = (outputs[q.id + '/' + c.name] ?? '').split('\n');
        console.log('  --- the last ' + Math.min(lines.length, 200) + ' lines of its output ---');
        console.log(lines.slice(-200).map((l) => '  | ' + l).join('\n'));
      }
    }
  }
}
console.log(judged.passed
  ? 'passed: the hopper takes a push of ' + head.slice(0, 12)
  : 'failed: fix what fails, commit, and run sh "$HOPPER_REQUIREMENTS" check again before you push');
process.exit(judged.passed ? 0 : 1);
`;
