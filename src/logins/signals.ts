// Login signals (issue #567): what a run printed that ends the login it waits on — a token obtained, the CLI saying
// it is logged in, or the job's own "Logged in." line the job rules ask for (completed); the code running out
// (expired); the user refusing (denied). Pure, no I/O. Anything else — a device-flow script polling
// (`authorization_pending`, `slow_down`, "waiting for authorization"), the same code printed again, the screen
// redrawn — is no signal: the login stays open. A line that says not, never or still waiting is no signal either,
// so Claude saying it still waits never completes one.

export type LoginSignal = 'completed' | 'expired' | 'denied';

// eslint-disable-next-line no-control-regex -- the colours a CLI prints are escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

/** Each signal by the words the CLIs (gh, codex, OAuth device-flow helpers per RFC 8628) and Claude use for it. */
const SIGNALS: readonly [LoginSignal, RegExp][] = [
  ['expired', /\bexpired_token\b|\b(?:device |user |one-time )?code (?:has )?expired\b|\bcode is expired\b/i],
  ['denied', /\baccess_denied\b|\b(?:authori[sz]ation|access|login|sign-in) (?:was )?denied\b/i],
  ['completed', new RegExp([
    /^[\s●⎿✓]*logged in[.!]?\s*$/, /\blogged in (?:as|to)\b/, /\bsuccessfully (?:logged|signed) in\b/, /\bauthentication (?:complete|completed|succeeded|successful)\b/,
    /\bauthori[sz]ation (?:complete|completed|succeeded|successful|granted)\b/, /\b(?:login|sign-in) (?:complete|completed|succeeded|successful|went through)\b/,
    /\b(?:access )?token (?:obtained|received|acquired|saved|stored|issued)\b/, /\bis now (?:authenticated|logged in|signed in)\b/,
  ].map((r) => r.source).join('|'), 'i')],
];

/** A line that says the opposite, or that it still waits. */
const NOT = /\bnot\b|n't\b|\bnever\b|\byet\b|\bstill\b|\bwaiting\b|\bpending\b|\bno longer\b/i;

/** The last login signal `text` shows, line by line; undefined when it shows none. */
export function loginSignalIn(text: string): LoginSignal | undefined {
  const lines = text.replace(ANSI, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const hit = SIGNALS.find(([, re]) => re.test(line));
    if (hit && (hit[0] !== 'completed' || !NOT.test(line))) return hit[0];
  }
  return undefined;
}
