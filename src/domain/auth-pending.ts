// Authentication pending (issues #472, #476, design.md "Run skills" and "Logins"): what a machine does when a login
// waits, in one place. A job (herdr) reads the line in its job rules: it reports the login with the HOPPER_AUTH_PENDING
// marker and waits, never with a question. A print-mode run has no tools and cannot run a login: its CLI prints the
// code, the hopper reads it from the run's output (src/logins/run-output.ts), and every run skill carries the section
// that tells the model never to touch a code. Pure text.

/** The job rules' login line (src/job-rules/index.ts `PROTOCOL_LINES`). */
export const AUTH_PENDING_LINE = 'When a command waits for a login (it shows a code to enter at a URL), never ask a question about it: leave the command running in the background, and end your message with a line containing only HOPPER_AUTH_PENDING, then one line each: tool: <the command>, url: <the URL>, code: <the code>, expires_in: <seconds until the code expires>, and, when the command shows them, account: <the account or host it signs in to>, scopes: <the scopes it asks for>. The user completes the login; then the command goes on and you continue. Report a login once per code, never again while you wait on it; when it goes through, say so in a line of its own: Logged in. Only you know whether a login worked: when it goes through, also tell the hopper: sh "$HOPPER_LOGIN" completed <tool>. When it fails, or a later check shows that it does not work, tell the hopper why: sh "$HOPPER_LOGIN" failed <tool> --reason "<why>".';

/** The section every run skill carries. */
export const PRINT_AUTH_SECTION = 'When this run waits for a login (a CLI shows a code to enter at a URL, or asks for a browser login), the hopper sees it and shows it to the user, who completes it. Never ask for, answer, guess or repeat a login code or a login URL, and never put one in your answer.';
