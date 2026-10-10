// How the client runs a fixed script's argv (issue #691): `env -u NAME …` is done here, not by the `env` program,
// which a Windows client does not have on its PATH. No I/O.

/** The program, its arguments and its environment: the variables a leading `env -u NAME` names removed. */
export function spawnOf(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): { file: string; args: string[]; env: Record<string, string | undefined> } {
  const out = { ...env };
  let i = 0;
  if (argv[0] === 'env') {
    i = 1;
    while (argv[i] === '-u' && argv[i + 1] !== undefined) {
      delete out[argv[i + 1]!];
      i += 2;
    }
  }
  return { file: argv[i]!, args: argv.slice(i + 1), env: out };
}
