import { describe, expect, it } from 'vitest';
import { FOOTER_ANCHOR, dialogOption, isBypassDialog, isTrustDialog, protocolFooter, readTurn, typedAfterQuestion } from '../../src/executors/herdr/screen.ts';

const CHROME = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

// Real capture of turn 1: Ink wraps the echoed prompt itself, so the footer arrives hard-wrapped.
const TURN_1 = [
  '❯ Create a file ... wait for the answer.',
  '  [hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a',
  '  line containing only: HOPPER_QUESTION',
  '  When the job is completely finished, end your final message with a line containing only: HOPPER_DONE',
  '  If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.',
  '● Which language should the greeting be in?',
  '  HOPPER_QUESTION',
  '✻ Cooked for 5s · done 9:45 PM',
];

const TURN_2 = [
  '❯ French.',
  '● I created greeting.txt in the current directory with a French greeting:',
  "  ▎ Bonjour ! J'espère que vous passez une excellente journée.",
  '  HOPPER_DONE',
  '✻ Worked for 8s · done 9:45 PM',
];

const screen = (...parts: string[][]): string => parts.flat().join('\n');

const PUBLISHING_RULE = "[hopper publishing rule] Any text you send to GitHub (commit messages, branch names, pull request titles and bodies, issue text) describes the change and how it was verified, in neutral terms. Never quote or name the repository owner or any other person. Never include personal or machine details: email addresses, people's names, IP addresses, hostnames, tailnet names, home directory paths, usernames, machine or pane ids, port numbers of local machines, codes, tokens or secrets.";

const WORK_TREE = "[hopper work tree] This job's work tree is /w/repo. Do all of the job's work inside it: clones, git worktrees, edits, builds, test runs, scratch and temporary files go under it. Never make or work in a copy of the code outside it, under /tmp or anywhere else. Temporary files go in /w/repo/.hopper-scratch: git ignores it, and TMPDIR and your scratchpad point there. Running or installing what you built, and reading files elsewhere, is fine. If the job seems to need a work tree outside this one, ask instead.";
const PROTOCOL = '[hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: HOPPER_QUESTION\n'
  + 'When the job is completely finished, end your final message with a line containing only: HOPPER_DONE\n'
  + 'If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.';

describe('protocol footer', () => {
  it('is the design text verbatim: the default job rules (publishing rule, parallel work), the work tree, then the three protocol lines', () => {
    expect(protocolFooter('/w/repo')).toBe(
      PUBLISHING_RULE + '\n'
      + '[hopper parallel work] Other jobs run at the same time as this one, possibly in the same repos. Nothing orders or holds jobs for each other: no job waits for another.\n'
      + 'If your work overlaps another job\'s, sort it out yourself. Either state the assumptions you made about the other work, or make the needed fix in the other project and annotate it with which way the dependency runs (which work depends on which).\n'
      + WORK_TREE + '\n'
      + PROTOCOL,
    );
  });

  it('carries the job rules it is given in place of the default; the work tree and the protocol stay (issue #172)', () => {
    expect(protocolFooter('/w/repo', 'Be brief.\nNever touch main.\n\n')).toBe(`Be brief.\nNever touch main.\n${WORK_TREE}\n${PROTOCOL}`);
    expect(protocolFooter('/w/repo', '  \n')).toBe(`${WORK_TREE}\n${PROTOCOL}`);
  });

  it('names the job\'s own work tree, whatever it is', () => {
    expect(protocolFooter('/srv/other')).toContain("This job's work tree is /srv/other.");
    expect(protocolFooter('/srv/other')).toContain('Temporary files go in /srv/other/.hopper-scratch');
  });

  it('anchors turn 1 on its last line, whatever the job rules', () => {
    expect(protocolFooter('/w/repo').split('\n').at(-1)).toBe(FOOTER_ANCHOR);
    expect(protocolFooter('/w/repo', 'my rule').split('\n').at(-1)).toBe(FOOTER_ANCHOR);
    expect(FOOTER_ANCHOR).toBe('If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.');
  });
});

describe('readTurn', () => {
  it('finds the question marker after the footer echo and the message before it', () => {
    const t = readTurn(screen(TURN_1, CHROME), FOOTER_ANCHOR);
    expect(t.lastMarker).toBe('question');
    expect(t.assistantText).toBe('Which language should the greeting be in?');
    expect(t.anchorFound).toBe(true);
  });

  it('ignores markers inside an echoed footer that Ink wrapped onto their own line', () => {
    const wrapped = [
      '❯ Do the thing.',
      '  [hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only:',
      '  HOPPER_QUESTION',
      '  When the job is completely finished, end your final message with a line containing only:',
      '  HOPPER_DONE',
      '  If the job cannot be done, end with a line containing only:',
      '  HOPPER_FAILED followed by the reason.',
    ];
    const t = readTurn(screen(wrapped, CHROME), FOOTER_ANCHOR);
    expect(t.lastMarker).toBeNull();
    expect(t.anchorFound).toBe(true);
  });

  it('does not see the previous turn marker after a resume', () => {
    const t = readTurn(screen(TURN_1, ['❯ French.', '● Working on it…'], CHROME), 'French.');
    expect(t.lastMarker).toBeNull();
    expect(t.lastLine).toBe('Working on it…');
  });

  it('reads the done marker of the resumed turn with the final assistant text', () => {
    const t = readTurn(screen(TURN_1, TURN_2, CHROME), 'French.');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe(
      "I created greeting.txt in the current directory with a French greeting:\nBonjour ! J'espère que vous passez une excellente journée.",
    );
  });

  it('anchors on the echoed answer, not a later repetition of the same words', () => {
    const t = readTurn(screen(['❯ yes', '● You said yes', '  HOPPER_DONE'], CHROME), 'yes');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe('You said yes');
  });

  it.each([
    ['`HOPPER_DONE`', 'done'],
    ['**HOPPER_DONE**', 'done'],
    ['● HOPPER_DONE', 'done'],
    ['  ⎿  HOPPER_QUESTION  ', 'question'],
    ['*HOPPER_QUESTION*', 'question'],
    ['HOPPER_DONE now', null],
    ['say HOPPER_DONE', null],
  ])('normalises marker line %j to %s', (line, marker) => {
    const t = readTurn(screen(['❯ go', '● ok', line], CHROME), 'go');
    expect(t.lastMarker).toBe(marker);
  });

  it('reads the FAILED reason from the same line', () => {
    const t = readTurn(screen(['❯ go', '● Cannot proceed.', '  HOPPER_FAILED: no network access'], CHROME), 'go');
    expect(t.lastMarker).toBe('failed');
    expect(t.failedReason).toBe('no network access');
  });

  it('reads the FAILED reason from the next line when the marker line is bare', () => {
    const t = readTurn(screen(['❯ go', '● Cannot proceed.', '  HOPPER_FAILED', '  the repo is missing'], CHROME), 'go');
    expect(t.lastMarker).toBe('failed');
    expect(t.failedReason).toBe('the repo is missing');
  });

  it('takes the last marker when a turn has several', () => {
    const t = readTurn(screen(['❯ go', '● First', '  HOPPER_QUESTION', '● Never mind, done.', '  HOPPER_DONE'], CHROME), 'go');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe('Never mind, done.');
  });

  it('reports the last assistant line for progress and no marker while working', () => {
    const t = readTurn(screen(['❯ go', '● Reading files', '● Bash(ls)', '  ⎿  a.txt', '✻ Cooking… (3s)'], CHROME), 'go');
    expect(t.lastMarker).toBeNull();
    expect(t.lastLine).toBe('a.txt');
  });

  it('does not report the effort indicator above the input box as progress', () => {
    // Real capture from the live demo: the right-aligned effort line became the progress message.
    const lines = ['❯ go', '● Writing hello.txt', '', '                                     ◐ medium · /effort'];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('Writing hello.txt');
  });

  it('does not report a Claude Code tip line as progress', () => {
    // Real capture from the live demo: a spinner tip became the progress message.
    const lines = ['❯ go', '● Writing hello.txt', '✻ Cooking… (3s)', '  ⎿  Tip: Run /install-github-app to tag @claude right from your Github issues and PRs'];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('Writing hello.txt');
  });

  it.each([
    ['· Symbioting… (20s · ↓ 121 tokens)'],
    ['* Coalescing… (8s · ↓ 296 tokens · thought for 1s)'],
    ['  (ctrl+b to run in background)'],
  ])('does not report spinner variant %j as progress (seen live)', (chrome) => {
    const t = readTurn(screen(['❯ go', '● Bash(sleep 90)', chrome], CHROME), 'go');
    expect(t.lastLine).toBe('Bash(sleep 90)');
  });

  // Real capture (issue #360): under the spinner sit a wrapped tip and the CLI's own update notice,
  // right-aligned above the input box. None of it is the agent's activity.
  const UNDER_SPINNER = [
    '✻ Actualizing… (22m 22s · ↓ 69.9k tokens)',
    '  ⎿  Tip: Use /btw to ask a quick side question',
    "     without interrupting Claude's current work",
    '             ✔ Update installed · Restart to update',
  ];

  it('does not report the update notice or a wrapped tip under the spinner as progress', () => {
    const lines = ['❯ go', '● Running 1 shell command · 5s…', '  ⎿  $ npx vitest run', '     (ctrl+b to run in background)', '', ...UNDER_SPINNER];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('$ npx vitest run');
  });

  it.each([
    ['             ✔ Update installed · Restart to update'],
    ['  ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code'],
  ])('does not report the CLI notice %j as progress when no spinner shows', (notice) => {
    const t = readTurn(screen(['❯ go', '● Writing hello.txt', '', notice], CHROME), 'go');
    expect(t.lastLine).toBe('Writing hello.txt');
  });

  it.each([
    ['* Crafting… (18m 43s · ↓ 41.8k tokens)'],
    ['· Hashing… (1h 2m · ↓ 86.3k tokens)'],
  ])('does not report the tip under the plain-glyph spinner %j as progress (seen live)', (spinner) => {
    const lines = ['❯ go', '● Bash(git show)', '  ⎿  grep "^+" | head -20', '', spinner, ...UNDER_SPINNER.slice(1)];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('grep "^+" | head -20');
  });

  it('reads the marker of a turn that ends above the update notice', () => {
    const t = readTurn(screen(['❯ go', '● All done.', '  HOPPER_DONE', '', '             ✔ Update installed · Restart to update'], CHROME), 'go');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe('All done.');
    expect(t.lastLine).toBe('All done.');
  });

  it('counts every line when the anchor scrolled out', () => {
    const t = readTurn(screen(['● Done all.', '  HOPPER_DONE'], CHROME), 'gone anchor');
    expect(t.anchorFound).toBe(false);
    expect(t.lastMarker).toBe('done');
  });

  it('returns empty text for an empty screen', () => {
    expect(readTurn('', 'x')).toMatchObject({ lastMarker: null, assistantText: '', lastLine: '' });
  });
});

const DIALOG = (path: string[]): string => [
  'claude --dangerously-skip-permissions',
  '╭─user@laptop /tmp/claude-1000/jhprobe',
  '╰─ claude --dangerously-skip-permissions',
  '────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ...path.map((p) => ` ${p}`),
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('isTrustDialog', () => {
  it('matches the dialog for this cwd', () => {
    expect(isTrustDialog(DIALOG(['/tmp/claude-1000/jhprobe']), '/tmp/claude-1000/jhprobe')).toBe(true);
  });

  it('matches a path wrapped across lines', () => {
    expect(isTrustDialog(DIALOG(['/home/user/workbench/very/long/', 'path/to/project']), '/home/user/workbench/very/long/path/to/project')).toBe(true);
  });

  it('tolerates a trailing slash on the cwd', () => {
    expect(isTrustDialog(DIALOG(['/tmp/x']), '/tmp/x/')).toBe(true);
  });

  it('rejects the dialog for another path, even a prefix of it', () => {
    expect(isTrustDialog(DIALOG(['/tmp/claude-1000/jhprobe']), '/tmp/other')).toBe(false);
    expect(isTrustDialog(DIALOG(['/tmp/claude-1000/jhprobe-evil']), '/tmp/claude-1000/jhprobe')).toBe(false);
  });

  it('rejects a screen that is not the trust dialog', () => {
    expect(isTrustDialog('Accessing workspace:\n/tmp/x\nsomething else', '/tmp/x')).toBe(false);
    expect(isTrustDialog('', '/tmp/x')).toBe(false);
  });
});

// Claude Code's warning when it starts with every permission granted (issue #267), as drawn.
const BYPASS_DIALOG = [
  '────────────────────────────────────────',
  ' WARNING: Claude Code running in Bypass Permissions mode',
  '',
  ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
  ' This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.',
  '',
  ' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
  '',
  ' ❯ No, exit',
  '   Yes, I accept',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('isBypassDialog', () => {
  it('matches the bypass permissions warning', () => {
    expect(isBypassDialog(BYPASS_DIALOG)).toBe(true);
  });

  it('rejects the trust dialog, a turn and the bypass status line under the input box', () => {
    expect(isBypassDialog(DIALOG(['/tmp/x']))).toBe(false);
    expect(isBypassDialog(screen(TURN_1, CHROME))).toBe(false);
  });
});

// A permission dialog as Claude Code draws it when it runs without every permission granted.
const PERMISSION = [
  '● Here is the plan:',
  '  1. Remove the build dir',
  '  2. Rebuild',
  '',
  '● Bash(rm -rf build)',
  '────────────────────────────────────────',
  ' Bash command',
  '',
  '   rm -rf build',
  '   Remove the build dir',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in /tmp/jh-work",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
].join('\n');

describe('dialogOption', () => {
  it('an option number picks that option of the dialog', () => {
    expect(dialogOption(PERMISSION, '1')).toBe('1');
    expect(dialogOption(PERMISSION, ' 2. ')).toBe('2');
  });

  it("an option's own words pick it, case and spacing aside", () => {
    expect(dialogOption(PERMISSION, 'yes')).toBe('1');
    expect(dialogOption(PERMISSION, "Yes, and don't ask again for rm commands in /tmp/jh-work")).toBe('2');
    expect(dialogOption(PERMISSION, 'No, and tell Claude what to do differently')).toBe('3');
  });

  it('a number past the options, or any other answer, picks nothing (it goes to Claude as text)', () => {
    expect(dialogOption(PERMISSION, '4')).toBeUndefined();
    expect(dialogOption(PERMISSION, 'Remove only build/cache instead')).toBeUndefined();
  });

  it('a numbered list in the transcript is not a dialog', () => {
    expect(dialogOption(['● Here is the plan:', '  1. Remove the build dir', '  2. Rebuild', ...CHROME].join('\n'), '1')).toBeUndefined();
  });
});

describe('typedAfterQuestion', () => {
  it('reads what the owner typed into the pane after the question', () => {
    expect(typedAfterQuestion(screen(TURN_1, ['❯ French.', '● Working on it'], CHROME), FOOTER_ANCHOR)).toBe('French.');
  });

  it('reads a wrapped, multi-line answer up to the reply', () => {
    expect(typedAfterQuestion(screen(TURN_1, ['❯ Use French,', '  and be polite.', '', '● ok'], CHROME), FOOTER_ANCHOR)).toBe('Use French,\nand be polite.');
  });

  it('nothing typed yet: undefined', () => {
    expect(typedAfterQuestion(screen(TURN_1, CHROME), FOOTER_ANCHOR)).toBeUndefined();
  });

  it('text still in the input box is not an answer', () => {
    expect(typedAfterQuestion(screen(TURN_1, ['──────────────────────────────', '❯ half typed', '──────────────────────────────']), FOOTER_ANCHOR)).toBeUndefined();
  });

  it('anchored on an earlier answer: reads the next typed line, not the anchor echo', () => {
    expect(typedAfterQuestion(screen(TURN_1, TURN_2, ['● Anything else?', '  HOPPER_QUESTION', '❯ No, stop.'], CHROME), 'French.')).toBe('No, stop.');
  });
});
