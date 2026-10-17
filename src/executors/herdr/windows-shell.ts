// The Windows shell a pane opens in (issue #367): a pure function, no I/O.

/** A PowerShell prompt (`PS C:\\Users\\dev>`), or Windows PowerShell 5.1 refusing `&&`. */
const POWERSHELL = /^PS [A-Za-z]:\\[^>]*>|is not a valid statement separator/;
/** A cmd prompt: `C:\\Users\\dev>`. */
const CMD = /^[A-Za-z]:\\[^>]*>/;

/**
 * The Windows shell a pane's screen shows (issue #367), else undefined. herdr opens a pane in the
 * machine's default shell, PowerShell on Windows; the hopper's pane commands are POSIX shell, which
 * neither PowerShell nor cmd runs. Git Bash and every other POSIX shell name nothing.
 */
export function windowsShellOf(text: string): 'PowerShell' | 'cmd' | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.some((l) => POWERSHELL.test(l))) return 'PowerShell';
  if (lines.some((l) => CMD.test(l))) return 'cmd';
  return undefined;
}
