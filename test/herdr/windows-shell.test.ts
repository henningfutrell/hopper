import { describe, expect, it } from 'vitest';
import { windowsShellOf } from '../../src/executors/herdr/windows-shell.ts';

describe('windowsShellOf', () => {
  it('names PowerShell by its prompt, or by its refusal of &&', () => {
    expect(windowsShellOf('Windows PowerShell\nCopyright (C) Microsoft Corporation.\n\nPS C:\\Users\\dev> ')).toBe('PowerShell');
    expect(windowsShellOf("At line:1 char:20\nThe token '&&' is not a valid statement separator in this version.")).toBe('PowerShell');
  });

  it('names cmd by its prompt', () => {
    expect(windowsShellOf('Microsoft Windows [Version 10.0.22631]\n\nC:\\Users\\dev>')).toBe('cmd');
  });

  it('names nothing for a POSIX shell, Git Bash included', () => {
    expect(windowsShellOf('$ cd /w && mkdir -p /w/.worktrees/@scratch\n$ ')).toBeUndefined();
    expect(windowsShellOf('dev@box MINGW64 /c/Users/dev\n$ ')).toBeUndefined();
    expect(windowsShellOf('')).toBeUndefined();
  });
});
