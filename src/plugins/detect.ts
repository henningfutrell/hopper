// The detection kit: what `detect` may look at (design.md "Plugin contract"). The real one; tests
// fake it at the DetectionKit seam (sdk.ts).
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { DetectionKit } from './sdk.ts';
import { runtimeSecrets, type RuntimeSecrets } from '../secrets/runtime.ts';

const VERSION_TIMEOUT_MS = 5000;

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** stdout of a finished run, or undefined on a non-zero exit, a spawn error, or the timeout. */
function run(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL', env, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

export function createDetectionKit(o: {
  env?: NodeJS.ProcessEnv;
  /** The runtime's secrets (src/secrets/runtime.ts); default from `env`. */
  secret?: RuntimeSecrets;
  timeoutMs?: number;
} = {}): DetectionKit & { timeoutMs: number } {
  const env = o.env ?? process.env;
  const secret = o.secret ?? runtimeSecrets(env);
  const timeoutMs = o.timeoutMs ?? VERSION_TIMEOUT_MS;
  const which = async (bin: string): Promise<string | undefined> => {
    if (bin.includes('/')) return isAbsolute(bin) && (await executable(bin)) ? bin : undefined;
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(dir, bin);
      if (await executable(candidate)) return candidate;
    }
    return undefined;
  };
  return {
    timeoutMs,
    which,
    async version(bin, args = ['--version']) {
      const path = await which(bin);
      if (!path) return undefined;
      const out = await run(path, args, timeoutMs, env);
      return out?.trim().split('\n')[0]?.trim() || undefined;
    },
    async succeeds(bin, args) {
      const path = await which(bin);
      return path !== undefined && (await run(path, args, timeoutMs, env)) !== undefined;
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async readable(path) {
      try {
        await access(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    async pythonImports(python, module) {
      const path = await which(python);
      if (!path) return false;
      return (await run(path, ['-c', `import ${module}`], timeoutMs, { ...env, PYTHONDONTWRITEBYTECODE: '1' })) !== undefined;
    },
    env: secret,
  };
}
