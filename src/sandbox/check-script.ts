// The read-only check's script (issue #716, item 4): what a check box runs, and how the hopper reads what it wrote. Pure.
// Each probe's snippet is written to a file under /tmp (the box's only writable place; HOPPER_CHECK_DIR in a test) and
// run alone, under a time limit, with its asset in $ASSET. For each, the box prints one line:
// `HOPPER-PROBE <n> <exit> <output, base64>`. The hopper decides from the exit code and the output whether the probe passed; a probe with no line did not run.
// The read credentials minted for the check (issue #797) come in the box's environment, never in the script: the script
// takes each into a shell variable and out of the environment at its start, writes each kubeconfig under /tmp, and gives
// a probe only the credential of its own asset.
import { DENIAL } from './probes.ts';
import { PROBE_OUTPUT_MAX, type CheckCredential, type ProbeOutcome, type ProbeResult, type ProbeRun } from '../domain/read-only-check.ts';

/** Where the hopper adds a box's tools (src/sandbox/tools.ts): the real binaries, past any wrapper on PATH. */
export const TOOLS_DIR = '/opt/hopper-tools/bin';
/** How long one probe may run, in seconds: terraform's first init fetches its provider. */
export const PROBE_S = 300;
const MARK = 'HOPPER-PROBE';

/** A value in single quotes, for sh. */
const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** One snippet as a file: a here-document whose end mark is not in it. */
function file(path: string, body: string, n: number): string {
  let end = `HOPPER_PROBE_${n}`;
  while (body.includes(end)) end += '_';
  return `cat > ${path} <<'${end}'\n${body}\n${end}`;
}

/** The names a credential's environment may use: the tools' own variables. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Credential `i`'s variable `name` in the box's environment. */
const boxName = (i: number, name: string): string => `HOPPER_CHECK_${i}_${name}`;
/** A credential's environment, its names checked: a name the script could not hold is a bug, never passed on. */
function envOf(c: CheckCredential): [string, string][] {
  return Object.entries(c.env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`a check credential's variable ${JSON.stringify(name)} is not an environment name`);
    return [name, value];
  });
}

/** The check box's environment for these credentials: each one's variables, and its kubeconfig, under its own prefix. */
export function checkEnv(credentials: readonly CheckCredential[]): Record<string, string> {
  return Object.fromEntries(credentials.flatMap((c, i) => [
    ...envOf(c).map(([name, value]) => [boxName(i, name), value]),
    ...(c.kubeconfig !== undefined ? [[boxName(i, 'KUBECONFIG'), c.kubeconfig]] : []),
  ]));
}

/** The script's start for the credentials: each value into a shell variable, out of the environment; each kubeconfig to a file. */
function takeCredentials(credentials: readonly CheckCredential[]): string[] {
  return credentials.flatMap((c, i) => [
    ...envOf(c).map(([name]) => `c${i}_${name}=$${boxName(i, name)}; unset ${boxName(i, name)}`),
    ...(c.kubeconfig !== undefined
      ? [`mkdir -p "$HOME/c${i}" && (umask 077 && printf '%s' "$${boxName(i, 'KUBECONFIG')}" > "$HOME/c${i}/kubeconfig") || exit 1; unset ${boxName(i, 'KUBECONFIG')}`]
      : []),
  ]);
}

/** The assignments a probe on `run`'s asset runs with: its credential's, or none. */
function credentialFor(run: ProbeRun, credentials: readonly CheckCredential[]): string {
  const i = credentials.findIndex((c) => c.asset.kind === run.kind && c.asset.name === run.asset);
  if (i === -1) return '';
  const c = credentials[i]!;
  return [
    ...envOf(c).map(([name]) => `${name}="$c${i}_${name}" `),
    ...(c.kubeconfig !== undefined ? [`KUBECONFIG="$HOME/c${i}/kubeconfig" `] : []),
  ].join('');
}

/** The script a check box runs for these probes, each with the credential minted for its asset (`checkEnv` gives the box them). */
export function checkScript(runs: readonly ProbeRun[], credentials: readonly CheckCredential[] = []): string {
  // A probe that is not run (issue #715), or that the template marks `skip` (issue #916), writes no line: its result says why.
  const steps = runs.flatMap((r, n) => (r.notRun !== undefined || r.mark === 'skip' ? [] : [step(r, n, credentials)]));
  return `# Made by the hopper (issue #716): the read-only check. Each write must be refused, each read must work.
export HOME="\${HOPPER_CHECK_DIR:-/tmp/hopper-check}" HOPPER_TOOLS="\${HOPPER_TOOLS:-${TOOLS_DIR}}"
mkdir -p "$HOME" && cd "$HOME" || exit 1
${[...takeCredentials(credentials), ...steps].join('\n')}
`;
}

/** One probe's step: its snippet and cleanup as files, run with its asset's credential and its own variables. */
function step(r: ProbeRun, n: number, credentials: readonly CheckCredential[]): string {
  const { probe, asset } = r;
  const dir = `"$HOME/p${n}"`;
  const vars = Object.entries(r.vars ?? {}).map(([name, value]) => `${name}=${quote(value)} `).join('');
  const env = `${credentialFor(r, credentials)}${vars}ASSET=${quote(asset)}`;
  const run = `${env} timeout ${PROBE_S} sh ${dir}/probe.sh > ${dir}/out 2>&1 < /dev/null; code=$?`;
  const cleanup = probe.cleanup ? `\nif [ "$code" -eq 0 ]; then ${env} timeout ${PROBE_S} sh ${dir}/cleanup.sh > /dev/null 2>&1 < /dev/null; fi` : '';
  return [
    `# ${probe.id} on ${asset}`,
    `mkdir -p ${dir}`,
    file(`${dir}/probe.sh`, probe.script, n),
    ...(probe.cleanup ? [file(`${dir}/cleanup.sh`, probe.cleanup, n)] : []),
    `${run}${cleanup}`,
    `printf '${MARK} %s %s %s\\n' ${n} "$code" "$(tail -c ${PROBE_OUTPUT_MAX * 2} ${dir}/out | base64 | tr -d '\\n')"`,
  ].join('\n');
}

/** What a probe did, from its exit code and output. */
function outcomeOf(run: ProbeRun, exit: number, output: string): ProbeOutcome {
  if (exit === 0) return 'allowed';
  return (run.probe.denial ?? DENIAL).test(output) ? 'denied' : 'error';
}

/** The result of each probe, from what the check box wrote: a probe it wrote no line for did not run. */
export function readResults(runs: readonly ProbeRun[], logs: string): ProbeResult[] {
  const lines = new Map<number, { exit: number; output: string }>();
  for (const line of logs.split(/\r?\n/)) {
    const m = new RegExp(`${MARK} (\\d+) (\\d+) ([A-Za-z0-9+/=]*)\\s*$`).exec(line);
    if (m) lines.set(Number(m[1]), { exit: Number(m[2]), output: Buffer.from(m[3]!, 'base64').toString('utf8') });
  }
  return runs.map((run, n): ProbeResult => {
    // A probe the template marks `expect-denied` (issue #916) expects a refusal: it passes only when its read is refused.
    const base = { id: run.probe.id, asset: run.asset, expect: run.mark === 'expect-denied' ? 'denied' as const : run.probe.expect, ...(run.mark ? { mark: run.mark } : {}) };
    const note = run.probe.note !== undefined ? { note: run.probe.note } : {};
    if (run.notRun !== undefined) return { ...base, outcome: 'not-run', passed: false, output: run.notRun, ...note };
    if (run.mark === 'skip') return { ...base, outcome: 'skipped', passed: true, output: 'not run: the template marks it skip' };
    const got = lines.get(n);
    if (!got) return { ...base, outcome: 'error', passed: false, output: 'it did not run', ...note };
    const outcome = outcomeOf(run, got.exit, got.output);
    const passed = outcome === base.expect;
    return { ...base, outcome, passed, exit: got.exit, output: got.output.trim().slice(-PROBE_OUTPUT_MAX), ...(passed ? {} : note) };
  });
}
