// What stands on the pane before Claude draws is never a dialog (issue #527): on a Windows machine every job failed
// "claude blocked at startup", the screen the base64 `-EncodedCommand` of the hopper's own PowerShell launch line;
// on a wsl one, the dependency-sharing command still on screen. Only a dialog the hopper knows, or one Claude shows
// (its cursor on an option, its key hints), is decided on; anything else is looked at again until the deadline.
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };
/** A Windows pane's launch line as captured live (shortened): PowerShell's encoded command, then its prompt. */
const POWERSHELL_LAUNCH = [
  'PS C:\\Users\\dev\\work> powershell.exe -NoLogo -NoProfile -EncodedCommand JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQA9ACcAUwB0AG8AcAAnADsAaQBmACgAKABHAGUAdAAtAEMAbwBtAG0AYQBuAGQAIABjAGwAYQB1AGQAZQAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQApAC4AQwBvAG0AbQBhAG4AZABUAHkAcABlACAALQBlAHEAIAAnAEUAeAB0AGUAcgBuAGEAbABTAGMAcgBpAHAAdAAnACkAewAmACAAYwBsAGEAdQBkAGUA',
];
/** The dependency-sharing command a wsl pane still showed when the screen was read. */
const DEPS_ECHO = [
  '$ sh -c \'t=$1; w=$2; age=$3; say() { printf "hopper-%s-%s\\n" deps "$1"; }; … rm -rf "$d.part" && mkdir -p "$d.part" && mv "$w/node_modules" "$d.part/node_modules" && mv "$d.part" "$d" || { say failed; exit 0; }; …\'',
  'hopper-deps-linked',
  '$ ',
];

describe('herdr-claude executor: the pane before Claude draws (issue #527)', () => {
  it('a Windows launch line echoed, herdr calling the agent not ready: looked at again until Claude is up; the job runs', async () => {
    const { herdr, executor } = setup({ startupEcho: { lines: POWERSHELL_LAUNCH, polls: 5 }, turns: [DONE] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.keys).toEqual([]);
    expect(herdr.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    expect(herdr.prompts).toHaveLength(1);
  });

  it('a setup command still on screen, herdr reporting Claude started but blocked: looked at again; the job runs', async () => {
    const { herdr, executor } = setup({ startupEcho: { lines: DEPS_ECHO, polls: 5, started: true }, turns: [DONE] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.keys).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it('a launch line that Claude never replaces: the start times out and is tried again in a new pane, never "blocked"', async () => {
    const { herdr, executor } = setup({ startupEcho: { lines: POWERSHELL_LAUNCH, polls: Infinity }, turns: [DONE] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    const error = out.kind === 'failed' ? out.error : '';
    expect(error).toMatch(/^claude did not start in 3 attempts: claude not ready at startup/);
    expect(error).not.toContain('blocked');
    expect(error).toContain('-EncodedCommand');
    expect(herdr.closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
    expect(progress.filter((p) => p.message?.includes('did not start'))).toHaveLength(2);
    expect(herdr.keys).toEqual([]);
  });
});
