// Issue #2427: the reap on a native Windows client failed with `sh: -c: line 1: unexpected EOF while looking for matching
// '"'`. Node gives a Windows program its argv as one command line, and writes a `\"` of an argument as `\\\"` there. The
// sh of Git for Windows (MSYS) reads a backslash as an escape only before a quote, so it read `\\"` back: the script it
// ran closed a quote early. Only the reap held a `\"` (the runtime config it writes again before a reset).
import { describe, expect, it } from 'vitest';
import { checkpointArgv } from '../../src/client/checkpoint.ts';
import { credentialArgv } from '../../src/client/credential.ts';
import { discoverArgv } from '../../src/client/discover.ts';
import { leftoverRemoveArgv, leftoversArgv } from '../../src/client/leftovers.ts';
import { reachArgv } from '../../src/client/reach.ts';
import { reapArgv, surveyArgv } from '../../src/client/reap.ts';

/** How Node (libuv's quote_cmd_arg) writes one argument on a Windows command line. */
function quoted(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
    slashes = 0;
  }
  return `"${out}${'\\'.repeat(slashes * 2)}"`;
}

/** How the MSYS runtime reads one quoted argument back: inside the quotes, a backslash escapes only a quote. */
function readMsys(word: string): string {
  if (!word.startsWith('"')) return word;
  let out = '';
  for (let i = 1; i < word.length; i++) {
    if (word[i] === '\\' && word[i + 1] === '"') { out += '"'; i++; } else if (word[i] === '"') break; else out += word[i];
  }
  return out;
}

const scripts: Record<string, string[]> = {
  reap: reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1'),
  'reap, kept': reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1', true),
  survey: surveyArgv(['C:/w']),
  discovery: discoverArgv(),
  reach: reachArgv('http://127.0.0.1:1'),
  checkpoint: checkpointArgv('job-1', 'C:/w/.worktrees/w/job-1', 'session'),
  leftovers: leftoversArgv(['C:/w']),
  'leftover removal': leftoverRemoveArgv('C:/w/.worktrees/@scratch/job-1'),
  credential: credentialArgv('job-1', 'C:/w/.worktrees/@scratch/job-1/credentials', 'gh', false),
};

describe('a fixed script on a Windows command line (issue #2427)', () => {
  it.each(Object.entries(scripts))('%s reaches the sh of Git for Windows as the client gave it', (_, argv) => {
    for (const arg of argv) expect(readMsys(quoted(arg))).toBe(arg);
  });
});
