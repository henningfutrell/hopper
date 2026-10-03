import { describe, expect, it } from 'vitest';
import { FOOTER_ANCHOR, PROTOCOL_FOOTER, isTrustDialog, readTurn } from '../../src/executors/herdr/screen.ts';

const CHROME = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

// Real capture of turn 1: Ink wraps the echoed prompt itself, so the footer arrives hard-wrapped.
const TURN_1 = [
  '❯ Create a file ... wait for the answer.',
  '  [job-hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a',
  '  line containing only: JOB_HOPPER_QUESTION',
  '  When the job is completely finished, end your final message with a line containing only: JOB_HOPPER_DONE',
  '  If the job cannot be done, end with a line containing only: JOB_HOPPER_FAILED followed by the reason.',
  '● Which language should the greeting be in?',
  '  JOB_HOPPER_QUESTION',
  '✻ Cooked for 5s · done 9:45 PM',
];

const TURN_2 = [
  '❯ French.',
  '● I created greeting.txt in the current directory with a French greeting:',
  "  ▎ Bonjour ! J'espère que vous passez une excellente journée.",
  '  JOB_HOPPER_DONE',
  '✻ Worked for 8s · done 9:45 PM',
];

const screen = (...parts: string[][]): string => parts.flat().join('\n');

describe('protocol footer', () => {
  it('is the design text verbatim, three lines', () => {
    expect(PROTOCOL_FOOTER).toBe(
      '[job-hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: JOB_HOPPER_QUESTION\n'
      + 'When the job is completely finished, end your final message with a line containing only: JOB_HOPPER_DONE\n'
      + 'If the job cannot be done, end with a line containing only: JOB_HOPPER_FAILED followed by the reason.',
    );
  });

  it('anchors turn 1 on its last line', () => {
    expect(FOOTER_ANCHOR).toBe('If the job cannot be done, end with a line containing only: JOB_HOPPER_FAILED followed by the reason.');
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
      '  [job-hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only:',
      '  JOB_HOPPER_QUESTION',
      '  When the job is completely finished, end your final message with a line containing only:',
      '  JOB_HOPPER_DONE',
      '  If the job cannot be done, end with a line containing only:',
      '  JOB_HOPPER_FAILED followed by the reason.',
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
    const t = readTurn(screen(['❯ yes', '● You said yes', '  JOB_HOPPER_DONE'], CHROME), 'yes');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe('You said yes');
  });

  it.each([
    ['`JOB_HOPPER_DONE`', 'done'],
    ['**JOB_HOPPER_DONE**', 'done'],
    ['● JOB_HOPPER_DONE', 'done'],
    ['  ⎿  JOB_HOPPER_QUESTION  ', 'question'],
    ['*JOB_HOPPER_QUESTION*', 'question'],
    ['JOB_HOPPER_DONE now', null],
    ['say JOB_HOPPER_DONE', null],
  ])('normalises marker line %j to %s', (line, marker) => {
    const t = readTurn(screen(['❯ go', '● ok', line], CHROME), 'go');
    expect(t.lastMarker).toBe(marker);
  });

  it('reads the FAILED reason from the same line', () => {
    const t = readTurn(screen(['❯ go', '● Cannot proceed.', '  JOB_HOPPER_FAILED: no network access'], CHROME), 'go');
    expect(t.lastMarker).toBe('failed');
    expect(t.failedReason).toBe('no network access');
  });

  it('reads the FAILED reason from the next line when the marker line is bare', () => {
    const t = readTurn(screen(['❯ go', '● Cannot proceed.', '  JOB_HOPPER_FAILED', '  the repo is missing'], CHROME), 'go');
    expect(t.lastMarker).toBe('failed');
    expect(t.failedReason).toBe('the repo is missing');
  });

  it('takes the last marker when a turn has several', () => {
    const t = readTurn(screen(['❯ go', '● First', '  JOB_HOPPER_QUESTION', '● Never mind, done.', '  JOB_HOPPER_DONE'], CHROME), 'go');
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
    const t = readTurn(screen(['● Done all.', '  JOB_HOPPER_DONE'], CHROME), 'gone anchor');
    expect(t.anchorFound).toBe(false);
    expect(t.lastMarker).toBe('done');
  });

  it('returns empty text for an empty screen', () => {
    expect(readTurn('', 'x')).toMatchObject({ lastMarker: null, assistantText: '', lastLine: '' });
  });
});

const DIALOG = (path: string[]): string => [
  'claude --dangerously-skip-permissions',
  '╭─user@server-laptop /tmp/claude-1000/jhprobe',
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
