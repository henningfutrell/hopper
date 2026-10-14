// The screens Claude Code shows as it starts, before its prompt, and what the hopper does at each (issue #533,
// design.md "Startup screens"): pure functions, no I/O. Claude is ready only when its own input box is on screen —
// herdr calls it idle and ready at its first-run theme picker. A screen the hopper knows is answered with its
// documented default; any other screen that asks something is asked of a person (issue #534, before-send.ts), never
// a wait nobody ends.

import { isBypassDialog, isImportsDialog, isTrustDialog, showsDialog } from './screen.ts';

/** What decides the answer to a startup screen: the instance's options and the directory Claude starts in. */
export interface StartupPolicy {
  /** The directory Claude starts in: the job worktree, else the work tree. */
  cwd: string;
  trustWorkdir: boolean;
  yolo: boolean;
  /** Claude's first-run screens get their defaults (the theme, the machine's API key, notices); off, each is a question. */
  unattended: boolean;
}

/** Keys that answer a screen, and the progress message saying so; or why the screen goes to the job's answerers. */
export type StartupStep = { keys: string[]; did: string } | { ask: string };

const SEPARATOR = /^\s*─{3,}/;
const CURSOR = /^\s*❯\s*(.*\S)?\s*$/;
const PRESS_ENTER = /Press Enter to continue/i;

/** Each screen opens on its refusing option; the next one down accepts. */
const DOWN_ENTER = ['down', 'enter'];

/** Claude's input box: a rule, the ❯ line, and a rule below it. Claude is ready for the prompt. */
export function promptShown(text: string): boolean {
  const lines = text.split('\n');
  return lines.some((l, i) => SEPARATOR.test(l) && /^\s*❯/.test(lines[i + 1] ?? '') && lines.slice(i + 2).some((m) => SEPARATOR.test(m)));
}

/** Claude's first-run theme picker: "Choose the text style that looks best with your terminal", the cursor on its default. */
export const isThemeScreen = (text: string): boolean => text.includes('Choose the text style');

/** Claude asking whether to use the API key in its environment: "Yes", then "No (recommended)" with the cursor. */
export const isApiKeyScreen = (text: string): boolean => text.includes('Detected a custom API key') && text.includes('Do you want to use this API key?');

/** Claude asking how to sign in: it has no credential on this machine. */
export const isLoginScreen = (text: string): boolean => text.includes('Select login method');

/** Claude at its prompt with no credential (its config seeded, so no login screen): "Not logged in · Run /login" under the input box. */
export const notSignedIn = (text: string): boolean => /Not logged in · Run \/login/.test(text);

/** Why a screen of Claude's with no credential goes to the job's answerers. */
export const NOT_SIGNED_IN = 'Claude is not signed in on this machine: sign it in there, or give it CLAUDE_CODE_OAUTH_TOKEN, then answer';

/** A cursor on an option outside Claude's input box: a select of Claude's, numbered or not. */
function cursorOutsideBox(text: string): boolean {
  const lines = text.split('\n');
  return lines.some((l, i) => CURSOR.test(l) && CURSOR.exec(l)![1] !== undefined && !SEPARATOR.test(lines[i - 1] ?? ''));
}

/** Whether the screen asks something: a dialog of Claude's (issue #527), a select, or a notice waiting for Enter. */
export const asksSomething = (text: string): boolean => showsDialog(text) || cursorOutsideBox(text) || PRESS_ENTER.test(text);

/**
 * What the hopper does at the startup screen on `text` (the table in design.md "Startup screens"), or undefined when
 * the screen asks nothing: Claude is still drawing, or a launch or setup command is still on it (issue #527).
 */
export function startupStep(text: string, o: StartupPolicy): StartupStep | undefined {
  if (isTrustDialog(text, o.cwd)) return o.trustWorkdir ? { keys: DOWN_ENTER, did: `trusted workdir ${o.cwd}` } : { ask: 'the work tree is not trusted: trustWorkdir is off' };
  if (isImportsDialog(text)) {
    return o.trustWorkdir ? { keys: DOWN_ENTER, did: 'allowed the external CLAUDE.md imports of the trusted work tree' } : { ask: 'the work tree is not trusted: trustWorkdir is off' };
  }
  if (isBypassDialog(text)) return o.yolo ? { keys: DOWN_ENTER, did: 'accepted bypass permissions mode' } : { ask: 'the instance is not yolo' };
  if (isLoginScreen(text)) return { ask: NOT_SIGNED_IN };
  if (!o.unattended && asksSomething(text)) return { ask: 'unattended is off' };
  if (isThemeScreen(text)) return { keys: ['enter'], did: 'kept the default text style' };
  if (isApiKeyScreen(text)) return { keys: ['up', 'enter'], did: 'used the API key the machine gives Claude' };
  if (PRESS_ENTER.test(text)) return { keys: ['enter'], did: 'went past a notice of Claude\'s' };
  if (asksSomething(text)) return { ask: 'the hopper has no default for this screen' };
  return undefined;
}

/**
 * Claude stands at a screen before its prompt, though herdr may call it idle (issue #533): no input box and the screen
 * asks something, or the prompt says Claude is not signed in.
 */
export const standsBeforePrompt = (text: string): boolean => (!promptShown(text) && asksSomething(text)) || notSignedIn(text);

const words = (s: string): string => s.replace(/^[\s❯✔✓]+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The keys that pick the option `answer` names on a select with no numbers and no key hints, as Claude's first-run
 * theme picker is (select-dialog.ts reads the ones with key hints): the cursor moved from its option to the one named —
 * the lines without a blank line around the cursor — then Enter. Undefined when the answer names none.
 */
export function cursorPick(text: string, answer: string): string[] | undefined {
  const lines = text.split('\n');
  const at = lines.findLastIndex((l, i) => CURSOR.test(l) && CURSOR.exec(l)![1] !== undefined && !SEPARATOR.test(lines[i - 1] ?? ''));
  if (at < 0) return undefined;
  let from = at;
  let to = at;
  while (from > 0 && lines[from - 1]!.trim() !== '') from--;
  while (to < lines.length - 1 && lines[to + 1]!.trim() !== '') to++;
  const target = lines.slice(from, to + 1).findIndex((l) => words(l) === words(answer));
  if (target < 0) return undefined;
  const moves = target + from - at;
  return [...Array<string>(Math.abs(moves)).fill(moves > 0 ? 'down' : 'up'), 'enter'];
}
