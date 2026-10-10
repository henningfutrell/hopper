// The environment every child process of an executor starts with.

/**
 * The credential the claude CLI signs in with where its login is not on the machine (docs/deploy.md): a hopper in a
 * container is given it, and its jobs' Claude reads it (issue #533). Not a child-session marker.
 */
const CLAUDE_CREDENTIAL = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The ssh agent's variables (issue #652): a job never reaches the host's keys through its agent. */
const SSH_AGENT = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID']);

/** The master key (issue #659) and the old token key, with their `_PREVIOUS` and `_FILE`: never given to a child process. */
const MASTER_KEY = /^HOPPER_(MASTER|TOKEN)_KEY(_PREVIOUS)?(_FILE)?$/;

/** `env` without the master key's variables. */
const keyless = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !MASTER_KEY.test(k)));

/**
 * process.env without CLAUDECODE and CLAUDE_CODE_* but the claude CLI's credential — a child-session marker must not leak
 * into panes —, without the ssh agent (issue #652), and without the master key.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(keyless(env)).filter(([k]) => !SSH_AGENT.has(k) && (k === CLAUDE_CREDENTIAL || (k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')))));
}

/** What a user added later keeps of the daemon's environment: the machine's variables, never a secret the runtime gives admin. */
const MACHINE_VARIABLE = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|XDG_RUNTIME_DIR|LC_[A-Z_]+)$/;

/**
 * The environment a user's process starts with (issue #158): the daemon's for admin (`userEnv` empty), without the master key;
 * for a user added later, only the machine's variables of it, then the user's own (their CLI config dirs).
 */
export function userProcessEnv(userEnv: Readonly<Record<string, string>> = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (Object.keys(userEnv).length === 0) return keyless(env);
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => MACHINE_VARIABLE.test(k))), ...userEnv };
}
