// The screens the fake herdr client shows (fake-client.ts): Claude Code's chrome and dialogs, and a
// Windows shell's answers. Test support only.

export const CHROME = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

/** The footer while background work runs (issue #491), as captured live: "⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage". */
export const backgroundFooter = (work: string): string => `  ⏵⏵ bypass permissions on · ${work} · ← for agents · ↓ to manage`;

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  text.split('\n').forEach((para, i) => {
    let line = i === 0 ? '❯' : ' ';
    for (const word of para.split(' ')) {
      if (line.length + 1 + word.length > width && line.trim() !== '' && line !== '❯') {
        out.push(line);
        line = ' ';
      }
      line += ` ${word}`;
    }
    out.push(line);
  });
  return out;
}

export function trustDialog(path: string): string[] {
  return [
    '─'.repeat(40), ' Accessing workspace:', '', ` ${path}`, '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.", '',
    ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel',
  ];
}

export function bypassDialog(): string[] {
  return [
    '─'.repeat(40), ' WARNING: Claude Code running in Bypass Permissions mode', '',
    ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.', '',
    ' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.', '',
    ' ❯ No, exit', '   Yes, I accept', '', ' Enter to confirm · Esc to cancel',
  ];
}

/** Claude Code's dialog when a CLAUDE.md it loads imports files outside the cwd (issue #518), as Claude Code 2.1.292 shows it: refusing option first. */
export function importsDialog(file: string): string[] {
  return [
    '─'.repeat(40), ' Allow external CLAUDE.md file imports?', '',
    " This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories.", '',
    ' External imports:', `   ${file}`, '',
    ' Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks https://code.claude.com/docs/en/security', '',
    ' ❯ No, disable external imports', '   Yes, allow external imports', '', ' Enter to confirm · Esc to cancel',
  ];
}

/** Claude Code's first-run theme picker, as 2.1.292 shows it in an empty home (issue #533): unnumbered, the cursor on the default. */
export function themeScreen(): string[] {
  return [
    ' Welcome to Claude Code v2.1.292', '', " Let's get started.", '', ' Choose the text style that looks best with your terminal', ' To change this later, run /theme', '',
    '     Auto (match terminal)', ' ❯ ✔ Dark mode', '     Light mode', '     Dark mode (colorblind-friendly)', '     Light mode (colorblind-friendly)', '',
    ' ╌'.padEnd(40, '╌'), '  1  function greet() {', ' ╌'.padEnd(40, '╌'), '  Syntax theme: Monokai Extended (ctrl+t to disable)',
  ];
}

/** Claude Code asking how to sign in, as 2.1.292 shows it in an empty home with no credential. */
export function loginScreen(): string[] {
  return [
    ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.', '', ' Select login method:', '',
    ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing',
    '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI',
  ];
}

/** Claude Code asking whether to use the API key in its environment, as 2.1.292 shows it: the refusing option focused. */
export function apiKeyScreen(): string[] {
  return [
    '─'.repeat(40), '  Detected a custom API key in your environment', '', '  ANTHROPIC_API_KEY: sk-ant-...0123456789abcdefghij', '',
    '  Do you want to use this API key?', '', '    Yes', '  ❯ No (recommended)', '', '  Enter to confirm · Esc to cancel',
  ];
}

/** A notice Claude Code shows once, waiting for Enter. */
export function noticeScreen(): string[] {
  return [' Security notes:', '', ' 1. Claude can make mistakes', ' 2. Due to prompt injection risks, only use it with code you trust', '', ' Press Enter to continue…'];
}

/** Each Windows shell's prompt, and the error it answers the hopper's POSIX commands with, then the prompt again (issue #367). */
export const WINDOWS_SHELLS = { powershell: ['PS C:\\Users\\dev> ', "The token '&&' is not a valid statement separator in this version."], cmd: ['C:\\Users\\dev>', 'The filename, directory name, or volume label syntax is incorrect.'] } as const;

/** The screens Claude shows before its prompt, in the order it shows them (the fake herdr's startup, issue #533); FakeHerdrOptions.startupBlockedBy comes after them. */
export type StartupScreen = 'theme' | 'login' | 'apiKey' | 'notice' | 'trust' | 'imports' | 'bypass';

/** The lines of a startup screen: the trust and imports dialogs name what the options give. */
export function startupScreen(kind: StartupScreen, o: { trustDialogFor?: string; importsDialog?: string }): string[] {
  if (kind === 'trust') return trustDialog(o.trustDialogFor!);
  if (kind === 'imports') return importsDialog(o.importsDialog!);
  return { theme: themeScreen, login: loginScreen, apiKey: apiKeyScreen, notice: noticeScreen, bypass: bypassDialog }[kind]();
}

/**
 * The startup screens a Claude starting now shows (issue #533): a home the hopper's seed wrote has onboarding done and the
 * work tree trusted; one without a config shows the first-run screens first. Then the options' dialogs, in Claude's order.
 */
export function startupScreens(o: { trustDialogFor?: string; importsDialog?: string; bypassDialog?: string; firstRun?: StartupScreen[] }, config: string): StartupScreen[] {
  const seeded = config === 'seeded';
  const shown: (StartupScreen | false | undefined)[] = [
    ...(config === 'absent' || config === 'unwritable' ? o.firstRun ?? ['theme', 'login'] : []),
    o.trustDialogFor !== undefined && !seeded && 'trust', o.importsDialog !== undefined && !seeded && 'imports', o.bypassDialog !== undefined && 'bypass',
  ];
  return shown.filter((m): m is StartupScreen => m !== false && m !== undefined);
}

/** What of a fake pane its screen shows. */
export interface ScreenOf { lines: string[]; mode: string; echoPolls?: number; hidden?: string[]; input?: string; background?: { work: string } }

/**
 * A fake pane's screen: its lines, the new-message indicator while the transcript is scrolled up, then Claude's input
 * box and footer — none at a dialog before its prompt, or while its launch line is still echoed (issue #533); the
 * footer says when Claude is not signed in.
 */
export function paneScreen(p: ScreenOf | undefined, signedIn: boolean): string {
  const indicator = p?.hidden ? ['                                               1 new message (ctrl+End) ↓'] : [];
  if (p && (p.mode !== 'none' || p.echoPolls !== undefined)) return [...p.lines, ...indicator].join('\n');
  const box = p?.input === undefined ? CHROME.slice(0, 3) : [CHROME[0]!, `❯ [Pasted text #1 +${p.input.split('\n').length - 1} lines]`, CHROME[2]!];
  const footer = p?.background ? backgroundFooter(p.background.work) : CHROME[3]!;
  return [...(p?.lines ?? []), ...indicator, ...box, signedIn ? footer : `${footer} · Not logged in · Run /login`].join('\n');
}

/**
 * Enter at a startup screen (`mode`): whether Claude goes on past it — refusing trust or the bypass warning (the cursor
 * not moved down to accept) quits Claude; refusing the imports goes on without them; the first-run screens go on with
 * whatever is picked. Undefined when `mode` is no startup screen of the queue.
 */
export function enterGoesOn(mode: string, sawDown: boolean): boolean | undefined {
  if (mode === 'trust' || mode === 'bypass') return sawDown;
  return ['imports', 'theme', 'login', 'apiKey', 'notice'].includes(mode) ? true : undefined;
}
