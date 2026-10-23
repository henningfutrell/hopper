// How the client runs a fixed script's argv (issue #691): `env -u NAME …` is done here, not by the `env` program,
// which a Windows client does not have on its PATH. No I/O.

/**
 * What a Windows client gives `sh -c` in place of the script (issue #2676): the script itself is in HOPPER_CLIENT_SCRIPT,
 * which it takes out of the environment before it runs it, so nothing the script starts sees it. A native Windows client
 * gives a program its arguments as one command line, and the sh of Git for Windows cut a script near 8 KiB there (`sh: -c:
 * line 2: syntax error: unexpected end of file`); the environment carries it whole.
 */
export const CLIENT_SCRIPT_SH = 'hopper_client_script=$HOPPER_CLIENT_SCRIPT; unset HOPPER_CLIENT_SCRIPT; eval "$hopper_client_script"';

/**
 * The program, its arguments and its environment: the variables a leading `env -u NAME` names removed. On Windows, a
 * `sh -c` script goes in the environment (CLIENT_SCRIPT_SH).
 */
export function spawnOf(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): { file: string; args: string[]; env: Record<string, string | undefined> } {
  const out = { ...env };
  let i = 0;
  if (argv[0] === 'env') {
    i = 1;
    while (argv[i] === '-u' && argv[i + 1] !== undefined) {
      delete out[argv[i + 1]!];
      i += 2;
    }
  }
  const file = argv[i]!, args = argv.slice(i + 1);
  if (platform === 'win32' && file === 'sh' && args[0] === '-c' && args[1] !== undefined) {
    return { file, args: ['-c', CLIENT_SCRIPT_SH, ...args.slice(2)], env: { ...out, HOPPER_CLIENT_SCRIPT: args[1] } };
  }
  return { file, args, env: out };
}
