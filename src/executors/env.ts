// The environment every child process of an executor starts with.

/** process.env without CLAUDECODE and CLAUDE_CODE_*: a child-session marker must not leak into panes. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
}
