// Device-code prompts as each CLI prints them (issue #476): pure functions, no I/O. A run the hopper reads
// as text — a print-mode run's output, a pane's screen — is checked against each CLI's own words, so a
// login it waits on goes to the logins and never becomes a question. Each recogniser is one CLI's, fed its
// real output in test/logins/recognise.test.ts; a CLI that changes its words is missed, never misread. Any other CLI,
// or a job's own words about one (issue #698), is read by its shape: a device page URL and, near it, a code the words
// call one (test/logins/recognise-any.test.ts). Its tool is the page's host.

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

interface Recogniser { tool: string; recognise(text: string): (Omit<DeviceCodePrompt, 'tool'> & { tool?: string }) | undefined }

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

/** A code the words call one: "enter the code ABCD-1234", "code: SPBX-QHWR" (next line too). Letters and digits, six or more. */
const ANY_CODE = /\bcode\b(?:\s+is)?\s*:?\s*[`"'*]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*|[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\b/g;
/** A URL whose host or path names a device login page: `/device`, `devicelogin`, `/activate`, `device.sso.…`. */
const DEVICE_URL = /https?:\/\/[^\s<>()`"'\]]+/g;
const DEVICE_PAGE = /device|activate|verif|pair|\/link\b|\/login\b|\/auth/i;
/** How far from its code a device page URL may be, in characters: a prompt is a few lines. */
const NEAR = 400;

/** The host a device page is on, as the tool's name: `www.` left out. */
const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');

/** Any other CLI, or the job's own words (issue #698): the last code the words name, with a device page URL near it. */
const any: Recogniser = {
  tool: '',
  recognise(text) {
    const codes = [...text.matchAll(ANY_CODE)].filter((m) => m[1]!.replaceAll('-', '').length >= 6 && /[A-Z]/.test(m[1]!));
    for (const code of codes.reverse()) {
      const at = code.index;
      const url = [...text.matchAll(DEVICE_URL)]
        .map((u) => ({ url: u[0].replace(/[.,;:!?]+$/, ''), d: Math.abs(u.index - at) }))
        .filter((u) => u.d <= NEAR && DEVICE_PAGE.test(u.url) && URL.canParse(u.url))
        .sort((a, b) => a.d - b.d)[0];
      if (!url) continue;
      const near = text.slice(Math.max(0, at - NEAR), at + NEAR);
      const exp = /expires? in (\d+) (minute|min|second|sec)/i.exec(near);
      const expiresInSec = exp ? Number(exp[1]) * (/^min/i.test(exp[2]!) ? 60 : 1) : DEFAULT_EXPIRES_IN_SEC;
      return { tool: hostOf(url.url), verificationUrl: url.url, userCode: code[1]!, expiresInSec };
    }
    return undefined;
  },
};

/** The CLIs the hopper knows by their words first: the same prompt is theirs, by name. */
const RECOGNISERS: readonly Recogniser[] = [gh, codex, any];

/** The device code the output shows last, of any CLI the hopper knows; undefined when none. */
export function recogniseDeviceCode(output: string): DeviceCodePrompt | undefined {
  const text = plain(output);
  let found: { at: number; prompt: DeviceCodePrompt } | undefined;
  for (const r of RECOGNISERS) {
    const p = r.recognise(text);
    if (!p) continue;
    const at = text.lastIndexOf(p.userCode);
    if (!found || at > found.at) found = { at, prompt: { ...p, tool: p.tool ?? r.tool } };
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
