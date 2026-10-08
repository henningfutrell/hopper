// Device-code prompts as each CLI prints them (issue #476): pure functions, no I/O. A run the hopper reads
// as text — a print-mode run's output, a pane's screen — is checked against each CLI's own words, so a
// login it waits on goes to the logins and never becomes a question. Each recogniser is one CLI's, fed its
// real output in test/logins/recognise.test.ts; a CLI that changes its words is missed, never misread.

/** A device code a CLI shows: where to enter it, the code, and how long it lasts. */
export interface DeviceCodePrompt {
  /** The CLI that waits: `gh`, `codex`. */
  tool: string;
  verificationUrl: string;
  userCode: string;
  expiresInSec: number;
}

/** RFC 8628's suggested lifetime, and GitHub's: what a CLI that prints none gets. */
export const DEFAULT_EXPIRES_IN_SEC = 900;

// eslint-disable-next-line no-control-regex -- the colours a CLI prints are escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const plain = (text: string): string => text.replace(ANSI, '');

/** A last match of `re` (global) in `text`. */
function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

interface Recogniser { tool: string; recognise(text: string): Omit<DeviceCodePrompt, 'tool'> | undefined }

/** gh: "! First copy your one-time code: XXXX-XXXX", then the URL to open (no terminal) or the Enter prompt (a terminal). */
const gh: Recogniser = {
  tool: 'gh',
  recognise(text) {
    const code = lastMatch(/First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/g, text);
    if (!code) return undefined;
    const url = /(?:continue in your web browser:|Press Enter to open)\s*(https?:\/\/\S+\/login\/device)\b/.exec(text.slice(code.index));
    return url ? { verificationUrl: url[1]!, userCode: code[1]!, expiresInSec: DEFAULT_EXPIRES_IN_SEC } : undefined;
  },
};

/** codex: "Follow these steps to sign in … using device code authorization", the link, then "Enter this one-time code (expires in N minutes)" and the code. */
const codex: Recogniser = {
  tool: 'codex',
  recognise(text) {
    const head = lastMatch(/using device code authorization/g, text);
    if (!head) return undefined;
    const m = /Open this link[^\n]*\n\s*(https?:\/\/\S+)\s*\n[\s\S]*?Enter this one-time code\s*(?:\(expires in (\d+) (minute|second)s?\))?[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(text.slice(head.index));
    if (!m) return undefined;
    const expiresInSec = m[2] === undefined ? DEFAULT_EXPIRES_IN_SEC : Number(m[2]) * (m[3] === 'minute' ? 60 : 1);
    return { verificationUrl: m[1]!, userCode: m[4]!, expiresInSec };
  },
};

const RECOGNISERS: readonly Recogniser[] = [gh, codex];

/** The device code the output shows last, of any CLI the hopper knows; undefined when none. */
export function recogniseDeviceCode(output: string): DeviceCodePrompt | undefined {
  const text = plain(output);
  let found: { at: number; prompt: DeviceCodePrompt } | undefined;
  for (const r of RECOGNISERS) {
    const p = r.recognise(text);
    if (!p) continue;
    const at = text.lastIndexOf(p.userCode);
    if (!found || at > found.at) found = { at, prompt: { tool: r.tool, ...p } };
  }
  return found?.prompt;
}

/** Every code the output's device-code prompts show. */
function codesIn(output: string): string[] {
  const text = plain(output);
  return RECOGNISERS.flatMap((r) => {
    const p = r.recognise(text);
    return p ? [p.userCode] : [];
  });
}

/**
 * `text` with every device code hidden: the codes `screen` shows a prompt for, and the `known` ones. What
 * the hopper keeps or sends of a run's output (progress, a question's recent output) never carries one.
 */
export function hideCodes(text: string, screen: string = text, known: readonly string[] = []): string {
  let out = text;
  for (const code of new Set([...codesIn(screen), ...known])) if (code) out = out.replaceAll(code, '[code hidden]');
  return out;
}
