// The environment every child process of an executor starts with.

/** process.env without CLAUDECODE and CLAUDE_CODE_*: a child-session marker must not leak into panes. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
}

/** What a user added later keeps of the daemon's environment: the machine's variables, never a secret the runtime gives owner. */
const MACHINE_VARIABLE = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|XDG_RUNTIME_DIR|LC_[A-Z_]+)$/;

/**
 * The environment a user's process starts with (issue #158): the daemon's for owner (`userEnv` empty);
 * for a user added later, only the machine's variables of it, then the user's own (their CLI config dirs).
 */
export function userProcessEnv(userEnv: Readonly<Record<string, string>> = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (Object.keys(userEnv).length === 0) return env;
  return { ...machineEnv(env), ...userEnv };
}

/** Only the machine's variables of an environment: no secret, no marker of a parent session. */
export function machineEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => MACHINE_VARIABLE.test(k)));
}
