// The ready-made out-of-band collector (issue #871 part 3, design.md "Out-of-band changes"). A read-only check: it runs
// kubectl, terraform and aws with the read credentials it is given, turns what they print into signals
// (src/domain/out-of-band-collect.ts), and reports them to the hopper, which judges each one. Not part of the daemon:
// whatever runs it on a schedule (cron, a systemd timer, a Kubernetes CronJob, a CI schedule) is the schedule.
//
//   node scripts/out-of-band-collector.ts [--hopper <url>] [--state <file>] [--since <ISO time>] [--dry-run]
//     [--argo] [--flux] [--terraform <dir>]... [--cloudtrail <region>]... [--kube-audit <file>]
//
// How it reports:
//   - in a hopper job (HOPPER_TOKEN_FILE set): to POST /job/infra-signals on HOPPER_URL, with the job's proxy token.
//   - else, as an outside collector: to POST /ui/api/out-of-band/signals with an API token, from a grant with the scope
//     `out-of-band:signals`. Its refresh token comes from the state file, or HOPPER_REFRESH_TOKEN the first time; each
//     refresh spends it, so the new one is written to the state file (mode 600) before anything else.
// The state file also keeps when the last whole run started: the audit logs are read from then (else from --since, else
// the last 24 hours). A signal reported twice is kept once, so an overlap costs nothing; a gap loses writes.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  argoSignals, cloudTrailSignals, fluxSignals, kubeAuditSignals, terraformSignal,
} from '../src/domain/out-of-band-collect.ts';
import { SIGNALS_MAX, type Signal } from '../src/domain/out-of-band.ts';

const USAGE = 'usage: out-of-band-collector.ts [--hopper <url>] [--state <file>] [--since <ISO time>] [--dry-run] '
  + '[--argo] [--flux] [--terraform <dir>]... [--cloudtrail <region>]... [--kube-audit <file>]';
const DAY_MS = 24 * 60 * 60 * 1000;

const { values } = parseArgs({
  options: {
    hopper: { type: 'string' },
    state: { type: 'string' },
    since: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    argo: { type: 'boolean', default: false },
    flux: { type: 'boolean', default: false },
    terraform: { type: 'string', multiple: true, default: [] },
    cloudtrail: { type: 'string', multiple: true, default: [] },
    'kube-audit': { type: 'string' },
  },
});

function usage(why: string): never {
  console.error(`out-of-band-collector: ${why}\n${USAGE}`);
  process.exit(2);
}

interface State { refresh?: string; lastRun?: string }

function readState(path: string | undefined): State {
  if (!path) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as State; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

function writeState(path: string, state: State): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const sources = values.argo || values.flux || values.terraform.length > 0 || values.cloudtrail.length > 0 || values['kube-audit'] !== undefined;
if (!sources) usage('name at least one source: --argo, --flux, --terraform, --cloudtrail, --kube-audit');
const tokenFile = process.env.HOPPER_TOKEN_FILE;
const hopper = (values.hopper ?? process.env.HOPPER_URL ?? '').replace(/\/+$/, '');
if (!values['dry-run']) {
  if (!hopper) usage('--hopper names the hopper\'s URL (in a job: HOPPER_URL)');
  if (!tokenFile && !values.state) usage('--state names the file that keeps the refresh token and the last run');
}
if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) usage('--since must be an ISO 8601 time');

const state = readState(values.state);
const started = new Date().toISOString();
const since = values.since ?? state.lastRun ?? new Date(Date.now() - DAY_MS).toISOString();

const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const failed: string[] = [];
const signals: Signal[] = [];

function collect(name: string, read: () => Signal[]): void {
  try { signals.push(...read()); } catch (e) {
    const err = e as { stderr?: string; message: string };
    failed.push(`${name}: ${(err.stderr || err.message).trim()}`);
  }
}

if (values.argo) collect('argo', () => argoSignals(JSON.parse(run('kubectl', ['get', 'applications.argoproj.io', '-A', '-o', 'json'])), started));
if (values.flux) {
  collect('flux', () => fluxSignals(JSON.parse(run('kubectl', ['get', 'kustomizations.kustomize.toolkit.fluxcd.io,helmreleases.helm.toolkit.fluxcd.io', '-A', '-o', 'json'])), started));
}
for (const dir of values.terraform) {
  collect(`terraform ${dir}`, () => {
    run('terraform', [`-chdir=${dir}`, 'init', '-input=false', '-no-color']);
    const p = spawnSync('terraform', [`-chdir=${dir}`, 'plan', '-detailed-exitcode', '-lock=false', '-input=false', '-no-color'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (p.error) throw p.error;
    const s = terraformSignal(dir, p.status ?? 1, `${p.stdout}${p.stderr}`, started);
    return s ? [s] : [];
  });
}
for (const region of values.cloudtrail) {
  collect(`cloudtrail ${region}`, () => cloudTrailSignals(JSON.parse(run('aws', [
    'cloudtrail', 'lookup-events', '--region', region, '--lookup-attributes', 'AttributeKey=ReadOnly,AttributeValue=false',
    '--start-time', since, '--end-time', started, '--output', 'json',
  ]))));
}
const auditLog = values['kube-audit'];
if (auditLog) {
  collect('kube-audit', () => {
    const r = kubeAuditSignals(readFileSync(auditLog, 'utf8'), since);
    if (r.skipped) console.error(`kube-audit: ${r.skipped} line(s) are no JSON, skipped`);
    return r.signals;
  });
}

async function post(path: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${hopper}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.trim()}`);
  return JSON.parse(text);
}

async function report(): Promise<void> {
  if (values['dry-run']) {
    console.log(JSON.stringify(signals, null, 2));
    return;
  }
  if (signals.length === 0) {
    console.log('nothing to report');
    return;
  }
  let token: string;
  let path: string;
  if (tokenFile) {
    token = readFileSync(tokenFile, 'utf8').trim();
    path = '/job/infra-signals';
  } else {
    const refresh = state.refresh ?? process.env.HOPPER_REFRESH_TOKEN;
    if (!refresh) usage('no refresh token: set HOPPER_REFRESH_TOKEN to a grant\'s (scope out-of-band:signals) the first time');
    const r = await post('/ui/auth/token/refresh', '', { refresh }) as { token: string; refresh: string };
    // The sent refresh token is spent now: keep its successor before anything can fail.
    state.refresh = r.refresh;
    writeState(values.state!, state);
    token = r.token;
    path = '/ui/api/out-of-band/signals';
  }
  let recorded = 0;
  let inBand = 0;
  let known = 0;
  for (let i = 0; i < signals.length; i += SIGNALS_MAX) {
    const a = await post(path, token, { signals: signals.slice(i, i + SIGNALS_MAX) }) as { recorded: unknown[]; inBand: unknown[]; known: number };
    recorded += a.recorded.length;
    inBand += a.inBand.length;
    known += a.known;
  }
  console.log(`${signals.length} signal(s): ${recorded} recorded, ${inBand} in band, ${known} reported before`);
}

try {
  await report();
} catch (e) {
  console.error(`out-of-band-collector: ${(e as Error).message}`);
  process.exit(1);
}
for (const f of failed) console.error(f);
if (failed.length > 0) process.exit(1);
// Only a whole run moves the place the audit logs are read from: a failed source is read again next time.
if (values.state && !values['dry-run']) writeState(values.state, { ...state, lastRun: started });
