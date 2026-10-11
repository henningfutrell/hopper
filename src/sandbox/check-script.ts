// The read-only check's script (issue #716, item 4): what a check box runs, and how the hopper reads what it wrote. Pure.
// Each probe's snippet is written to a file under /tmp (the box's only writable place; HOPPER_CHECK_DIR in a test) and
// run alone, under a time limit, with its asset in $ASSET. For each, the box prints one line:
// `HOPPER-PROBE <n> <exit> <output, base64>`. The hopper decides from the exit code and the output whether the probe passed; a probe with no line did not run.
import { DENIAL } from './probes.ts';
import { PROBE_OUTPUT_MAX, type ProbeOutcome, type ProbeResult, type ProbeRun } from '../domain/read-only-check.ts';

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

/** The script a check box runs for these probes. */
export function checkScript(runs: readonly ProbeRun[]): string {
  const steps = runs.map(({ probe, asset }, n) => {
    const dir = `"$HOME/p${n}"`;
    const run = `ASSET=${quote(asset)} timeout ${PROBE_S} sh ${dir}/probe.sh > ${dir}/out 2>&1 < /dev/null; code=$?`;
    const cleanup = probe.cleanup ? `\nif [ "$code" -eq 0 ]; then ASSET=${quote(asset)} timeout ${PROBE_S} sh ${dir}/cleanup.sh > /dev/null 2>&1 < /dev/null; fi` : '';
    return [
      `# ${probe.id} on ${asset}`,
      `mkdir -p ${dir}`,
      file(`${dir}/probe.sh`, probe.script, n),
      ...(probe.cleanup ? [file(`${dir}/cleanup.sh`, probe.cleanup, n)] : []),
      `${run}${cleanup}`,
      `printf '${MARK} %s %s %s\\n' ${n} "$code" "$(tail -c ${PROBE_OUTPUT_MAX * 2} ${dir}/out | base64 | tr -d '\\n')"`,
    ].join('\n');
  });
  return `# Made by the hopper (issue #716): the read-only check. Each write must be refused, each read must work.
export HOME="\${HOPPER_CHECK_DIR:-/tmp/hopper-check}" HOPPER_TOOLS="\${HOPPER_TOOLS:-${TOOLS_DIR}}"
mkdir -p "$HOME" && cd "$HOME" || exit 1
${steps.join('\n')}
`;
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
  return runs.map((run, n) => {
    const base = { id: run.probe.id, asset: run.asset, expect: run.probe.expect };
    const got = lines.get(n);
    if (!got) return { ...base, outcome: 'error', passed: false, output: 'it did not run' };
    const outcome = outcomeOf(run, got.exit, got.output);
    return { ...base, outcome, passed: outcome === run.probe.expect, exit: got.exit, output: got.output.trim().slice(-PROBE_OUTPUT_MAX) };
  });
}
