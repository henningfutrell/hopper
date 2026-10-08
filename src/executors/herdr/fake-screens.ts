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

/** Each Windows shell's prompt, and the error it answers the hopper's POSIX commands with, then the prompt again (issue #367). */
export const WINDOWS_SHELLS = { powershell: ['PS C:\\Users\\dev> ', "The token '&&' is not a valid statement separator in this version."], cmd: ['C:\\Users\\dev>', 'The filename, directory name, or volume label syntax is incorrect.'] } as const;
