// A limit prompt on a job's pane (issue #2897, design.md "Limit prompts"): what the table of src/domain/limit-prompts.ts
// reads of the screen. Pure.
import { limitPromptIn, type LimitPrompt } from '../../domain/limit-prompts.ts';
import { SEPARATOR, USER_ECHO, anchorLine, isChrome, transcriptEnd } from './screen.ts';

/**
 * The limit prompt the turn stops at: among its last lines, or in the dialog below them. The input box and the footer under
 * it are never read: the CLI's warnings before a limit sit there. Anchor off screen: the screen's own lines. Not
 * `turnLines`: what hangs under a spinner is chrome there, and the prompt may be what follows one.
 */
export function limitPromptOnTurn(text: string, anchor: string): LimitPrompt | undefined {
  const all = text.split('\n');
  const end = transcriptEnd(all);
  const dialog = USER_ECHO.test(all[end + 1] ?? '') ? [] : all.slice(end + 1);
  const turn = all.slice(anchorLine(all, anchor) + 1, end).filter((l) => !isChrome(l) && !SEPARATOR.test(l));
  return limitPromptIn(dialog, dialog.length) ?? limitPromptIn(turn);
}
