// Every secret comes from the runtime (design.md "Secrets", issue #56): the hopper's runtime is never
// guaranteed, so a secret named NAME is the environment variable NAME, or the file the variable
// NAME_FILE names — a mounted secret (container or orchestrator secrets, a service manager's
// credentials, a secrets manager's agent). The file is read at every call, so a secret the runtime
// rotates is used at once. The hopper keeps no secret itself: not in the database, not in a file.
import { readFileSync } from 'node:fs';

/** A secret by name, from the runtime; undefined when neither NAME nor NAME_FILE gives one. */
export type RuntimeSecrets = (name: string) => string | undefined;

export function runtimeSecrets(env: Record<string, string | undefined>): RuntimeSecrets {
  return (name) => {
    const value = env[name] || undefined;
    const file = env[`${name}_FILE`] || undefined;
    if (value !== undefined && file !== undefined) throw new Error(`${name} and ${name}_FILE are both set; set one`);
    if (file === undefined) return value;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`${name}_FILE: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
    }
    return text.replace(/\r?\n$/, '') || undefined;
  };
}
