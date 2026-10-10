import { describe, expect, it } from 'vitest';
import { FOOTER_ANCHOR, dialogOption, isBypassDialog, isTrustDialog, protocolFooter, readTurn, typedAfterQuestion, windowsShellOf } from '../../src/executors/herdr/screen.ts';

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
const PROTOCOL = '[hopper protocol] When you need an answer from the user, ask exactly one question, in Simplified Technical English (ASD-STE100), in Markdown: one short sentence that says what you need first, then the context, with the options as a numbered list. End your message with a line containing only: HOPPER_QUESTION\n'
  + 'If your question needs research or a proposal before it can be answered, say so on a line of its own before HOPPER_QUESTION: "Suggest: research — <the aspect>" or "Suggest: proposal — <the aspect>". A person decides.\n'
  + 'When you are asked to research, do not do the work: research, then write a research report in Simplified Technical English (ASD-STE100), each part on a line of its own starting with its label — Question:, Findings:, Sources and evidence:, Confidence:, Open threads:, Next step: —. Write each part in Markdown, with a short summary first, then lists, code spans and links where they help. End your message with a line containing only: HOPPER_RESEARCH_REPORT. A person accepts it, asks you to dig deeper, or steers you; you keep your session meanwhile.\n'
  + 'When you are asked for a proposal, do not do the work: write the proposal in Simplified Technical English (ASD-STE100), as Markdown, as a set of alternative paths. Start with TL;DR: (one or two sentences) and Problem: (a short problem statement). Then write each path as a heading "Path N: <title>" with these lines: Summary:, Security:, Effort:, Risk:, Friction: (for the person), Creates: (the jobs, issues or research that continuing with it creates), and more detail in Markdown if needed. Then Recommended: the number of the path, or the numbers of a combination, and why in one or two sentences. If no change is needed or no viable path was found, write Paths: none — and the reason. End with Context: (what you read and relied on), then a line containing only: HOPPER_PROPOSAL. A person selects one or more paths to continue with; you are told the decision, or what to change.\n'
  + 'Never log in to GitHub yourself: no gh auth login, no device code. When a GitHub operation needs a login you lack (filing an issue, opening a pull request from your pushed branch, reading an issue or pull request, and the like), ask the hopper, which does it with its own GitHub connection: run sh "$HOPPER_GH" help to see how.\n'
  + 'When you need something set up from outside this machine, or a credential (a read-only link to a cluster or an AWS account, a token for another service, and the like), or a place to show a person a file you made (a chart, an HTML page, a report: the artifacts skill), ask the hopper what it can set up: run sh "$HOPPER_SKILL". Load a skill only when you need it. Never ask for a credential in a question. When the hopper says no, it says why: find another way.\n'
  + 'When a command waits for a login (it shows a code to enter at a URL), never ask a question about it: leave the command running in the background, and end your message with a line containing only HOPPER_AUTH_PENDING, then one line each: tool: <the command>, url: <the URL>, code: <the code>, expires_in: <seconds until the code expires>. The user completes the login; then the command goes on and you continue. Report a login once per code, never again while you wait on it; when it goes through, say so in a line of its own: Logged in.\n'
  + 'When the job is blocked on something only a person or the outside world can do (access to be granted, a review, a release), and you have nothing else to do, end your message with a line containing only HOPPER_WAITING, then one line: for: <what you wait for>, and, if you can, one line: until: <how you will know it happened>. To be woken when it happens, first start a command in the background that ends when it happens (a poll), and name it in until:. While you wait, the hopper does not prompt you; a person can also end the wait. Never open a question only to wait.\n'
  + 'When the job is completely finished, end your final message with a line containing only: HOPPER_DONE\n'
  + 'If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.';

describe('protocol footer', () => {
  it('is the design text verbatim: the default job rules (publishing rule, parallel work, writing style, formatting), the work tree, then the ten protocol lines', () => {
    expect(protocolFooter('/w/repo')).toBe(
      PUBLISHING_RULE + '\n'
      + '[hopper parallel work] Other jobs run at the same time as this one, possibly in the same repos. Nothing orders or holds jobs for each other: no job waits for another.\n'
      + 'If your work overlaps another job\'s, sort it out yourself. Either state the assumptions you made about the other work, or make the needed fix in the other project and annotate it with which way the dependency runs (which work depends on which).\n'
      + '[hopper writing style] Write all text for people in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, active voice, simple common words, one meaning per word.\n'
      + '[hopper formatting] Format the text you write for a person in the hopper (a question, a research report, a proposal, a note) in Markdown: a short summary first, then sections and lists. Put names, paths and commands in code spans. Do not use raw HTML or images.\n'
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

  it('names the job\'s own scratch dir when it has one, and says the hopper stops its processes and removes it at the end (issue #401)', () => {
    const footer = protocolFooter('/w/repo', '', '/w/repo/.hopper-scratch/j1');
    expect(footer).toContain('Temporary files, and clones or git worktrees made only for this job, go in /w/repo/.hopper-scratch/j1: git ignores it, and TMPDIR and your scratchpad point there, through a short link in /tmp, so a Unix socket path under TMPDIR fits.');
    expect(footer).toContain('When the job ends, the hopper stops every process the job started and removes that directory, unless a repository in it holds uncommitted or unpushed work.');
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

describe('windowsShellOf', () => {
  it('names PowerShell by its prompt, or by its refusal of &&', () => {
    expect(windowsShellOf('Windows PowerShell\nCopyright (C) Microsoft Corporation.\n\nPS C:\\Users\\dev> ')).toBe('PowerShell');
    expect(windowsShellOf("At line:1 char:20\nThe token '&&' is not a valid statement separator in this version.")).toBe('PowerShell');
  });

  it('names cmd by its prompt', () => {
    expect(windowsShellOf('Microsoft Windows [Version 10.0.22631]\n\nC:\\Users\\dev>')).toBe('cmd');
  });

  it('names nothing for a POSIX shell, Git Bash included', () => {
    expect(windowsShellOf('$ cd /w && mkdir -p /w/.hopper-scratch\n$ ')).toBeUndefined();
    expect(windowsShellOf('dev@box MINGW64 /c/Users/dev\n$ ')).toBeUndefined();
    expect(windowsShellOf('')).toBeUndefined();
  });
});
