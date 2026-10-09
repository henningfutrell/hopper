// Claude never blocks a job on a screen before its prompt (issue #533): Claude's config is seeded where the machine
// has none, so a fresh home starts with no key press; a known first-run screen gets its documented default; any other
// screen — herdr calling Claude idle at it or not — is asked of a person (issue #534), and the answer picks its
// option, then the job's prompt goes. Over the fake herdr, whose startup screens are Claude Code 2.1.292's as captured
// in an empty home, and which, as herdr does, moves no state_change_seq between them; on this machine, a client target
// (a Windows computer) and an ssh machine (a wsl one).
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { apiKeyScreen, themeScreen, trustDialog } from '../../src/executors/herdr/fake-screens.ts';
import { cursorPick, promptShown, startupStep } from '../../src/executors/herdr/startup-screens.ts';
import { CWD, contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };
const UPDATE = ['─'.repeat(40), ' Claude Code needs to update', '', ' ❯ 1. Update now', '   2. Exit', '', ' Enter to confirm · Esc to cancel'];
const STUDIO: MachineSnapshot = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['herdr-claude'], client: {}, workTree: CWD };
const WSL: MachineSnapshot = { id: 'wsl', label: 'wsl', maxLanes: 1, online: true, executors: ['herdr-claude'], ssh: 'wsl', herdr: { session: 'jh-there' }, workTree: CWD };
const POLICY = { cwd: CWD, trustWorkdir: true, yolo: true, unattended: true };
/** Keys the hopper sent other than the ones that close a pane. */
const answered = (keys: { keys: string[] }[]): string[][] => keys.map((k) => k.keys).filter((k) => !k.includes('ctrl+c') && !(k.length === 1 && k[0] === 'esc'));

describe('startup screens: what the hopper does at each (issue #533)', () => {
  it('Claude is ready only when its input box is on screen', () => {
    expect(promptShown(['✻ Welcome', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on'].join('\n'))).toBe(true);
    expect(promptShown(themeScreen().join('\n'))).toBe(false);
    expect(promptShown(trustDialog(CWD).join('\n'))).toBe(false);
  });

  it.each([
    ['the theme picker', themeScreen(), POLICY, { keys: ['enter'], did: 'kept the default text style' }],
    ['the API key in the environment', apiKeyScreen(), POLICY, { keys: ['up', 'enter'], did: 'used the API key the machine gives Claude' }],
    ['the theme picker, not unattended', themeScreen(), { ...POLICY, unattended: false }, { ask: 'unattended is off' }],
    ['a screen it has no default for', UPDATE, POLICY, { ask: 'the hopper has no default for this screen' }],
    ['the work tree\'s trust dialog, trusted', trustDialog(CWD), { ...POLICY, unattended: false }, { keys: ['down', 'enter'], did: `trusted workdir ${CWD}` }],
  ] as const)('%s', (_name, screen, policy, step) => {
    expect(startupStep(screen.join('\n'), policy)).toEqual(step);
  });

  it('a screen that asks nothing is no step: Claude still drawing, a launch line echoed', () => {
    expect(startupStep('PS C:\\Users\\dev> powershell.exe -NoLogo -EncodedCommand JABF', POLICY)).toBeUndefined();
  });

  it('an answer picks an option of a select with no numbers and no key hints (the theme picker) by its words', () => {
    expect(cursorPick(themeScreen().join('\n'), 'Light mode')).toEqual(['down', 'enter']);
    expect(cursorPick(themeScreen().join('\n'), 'auto (match terminal)')).toEqual(['up', 'enter']);
    expect(cursorPick(themeScreen().join('\n'), 'maybe')).toBeUndefined();
  });
});

describe('herdr-claude executor: a fresh home starts with no key press (issue #533)', () => {
  it('no config on the machine: the seed writes one, Claude goes straight to its prompt, nothing is answered', async () => {
    const { herdr, executor } = setup({ claudeConfig: 'absent', trustDialogFor: CWD, importsDialog: '/home/dev/work/AGENTS.md', turns: [DONE] }, { unattended: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(herdr.seeds).toEqual([[CWD, '1', '1']]);
    expect(answered(herdr.keys)).toEqual([]);
    expect(progress.map((p) => p.message)).toContain("seeded claude's config: the machine had none");
    expect(herdr.prompts).toHaveLength(1);
  });

  it('a config the user has is kept: the seed writes nothing, the screens get their defaults', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, turns: [DONE] }, { unattended: true, yolo: false });
    expect((await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).kind).toBe('finished');
    expect(herdr.seeds).toEqual([[CWD, '1', '0']]);
    expect(answered(herdr.keys)).toEqual([['down', 'enter']]);
  });

  it('unattended off: no seed, no pane environment of it, and a first-run screen is a question', async () => {
    const { herdr, executor } = setup({ claudeConfig: 'absent', firstRun: ['theme'], turns: [DONE] }, { unattended: false });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'question' && out.question.text).toContain('Choose the text style');
    expect(herdr.prompts).toEqual([]);
    expect(herdr.seeds).toEqual([]);
    const tab = herdr.calls.find((c) => c.method === 'createTab')!.args[0] as { env: Record<string, string> };
    expect(tab.env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it('unattended: the pane never updates Claude, so no update notice stands in its way', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { unattended: true });
    await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    const tab = herdr.calls.find((c) => c.method === 'createTab')!.args[0] as { env: Record<string, string> };
    expect(tab.env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('herdr calls Claude idle and ready at the theme picker: it is answered, never typed into', async () => {
    const { herdr, executor } = setup({ claudeConfig: 'unwritable', firstRun: ['theme', 'notice', 'apiKey'], idleAtStartupScreens: true, turns: [DONE] }, { unattended: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(answered(herdr.keys)).toEqual([['enter'], ['enter'], ['up', 'enter']]);
    expect(progress.map((p) => p.message)).toEqual(expect.arrayContaining([
      "claude's config could not be seeded: its startup screens get their defaults", 'kept the default text style', "went past a notice of Claude's", 'used the API key the machine gives Claude',
    ]));
    expect(herdr.prompts).toHaveLength(1);
  });
});

describe('herdr-claude executor: an unknown startup screen is a question, never a hang (issues #533, #534)', () => {
  it('the question carries the screen; the answer picks its option; then the job\'s prompt goes and the job runs', async () => {
    const { herdr, executor } = setup({ startupBlockedBy: UPDATE, turns: [DONE] }, { unattended: true });
    const first = contextFor(jobWith({ prompt: 'go' }));
    const asked = await executor.run(first.ctx);
    expect(asked).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    expect(asked.kind === 'question' && asked.question.text).toContain('Update now');
    expect(herdr.prompts).toEqual([]);
    const state = first.saved.at(-1)!;
    expect(state).toMatchObject({ turn: { unsent: true } });
    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: state }));
    expect((await executor.resume!(again.ctx, 'Update now')).kind).toBe('finished');
    expect(herdr.texts.map((t) => t.text)).toContain('1');
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]!.text).toMatch(/^go\n\n/);
  });

  it('a first-run screen herdr calls idle at, not unattended: asked; the answer picks its option by its words', async () => {
    const { herdr, executor } = setup({ claudeConfig: 'unwritable', firstRun: ['theme'], idleAtStartupScreens: true, turns: [DONE] }, { unattended: false });
    const first = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(first.ctx)).kind).toBe('question');
    expect(herdr.prompts).toEqual([]);
    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1)! }));
    expect((await executor.resume!(again.ctx, 'Light mode')).kind).toBe('finished');
    expect(answered(herdr.keys)).toEqual([['down', 'enter']]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it('Claude not signed in on the machine: a question, never a wait', async () => {
    const { executor } = setup({ claudeConfig: 'unwritable', firstRun: ['theme', 'login'], turns: [DONE] }, { unattended: true });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'question' && out.question.text).toContain('Claude is not signed in on this machine');
    expect(out.kind === 'question' && out.question.text).toContain('Claude account with subscription');
  });

  it('Claude at its prompt with no credential: a question, never the job\'s prompt; answered once signed in, nothing typed', async () => {
    const { herdr, executor } = setup({ claudeConfig: 'absent', notSignedIn: true, turns: [DONE] }, { unattended: true });
    const first = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(first.ctx);
    expect(out.kind === 'question' && out.question.text).toContain('Claude is not signed in on this machine');
    expect(herdr.prompts).toEqual([]);
    const still = await executor.resume!(contextFor(jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1)! })).ctx, 'signed in');
    expect(still.kind === 'question' && still.question.text).toContain('Claude is not signed in on this machine');
    herdr.signIn();
    expect((await executor.resume!(contextFor(jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1)! })).ctx, 'signed in now')).kind).toBe('finished');
    expect(herdr.texts).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it.each([
    ['a Windows computer (a client target)', STUDIO, 'studio'],
    ['a wsl machine (over ssh)', WSL, 'wsl'],
  ] as const)('on %s: seeded there, a fresh home starts with no key press; an unknown screen is a question', async (_name, machine, key) => {
    const fresh = setup({}, { unattended: true, remote: { [key]: { claudeConfig: 'absent', trustDialogFor: CWD, turns: [DONE] } } });
    const run = contextFor(jobWith({ prompt: 'go' }), `${machine.id}/lane-1`, machine);
    expect((await fresh.executor.run(run.ctx)).kind).toBe('finished');
    const there = fresh.remotes.get(key)!;
    expect(there.seeds).toHaveLength(1);
    expect(answered(there.keys)).toEqual([]);
    const unknown = setup({}, { unattended: true, remote: { [key]: { startupBlockedBy: UPDATE, turns: [DONE] } } });
    const asked = await unknown.executor.run(contextFor(jobWith({ prompt: 'go' }), `${machine.id}/lane-1`, machine).ctx);
    expect(asked.kind).toBe('question');
  });
});
