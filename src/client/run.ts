// One fixed script's run on this machine, for the client's signed calls (server.ts): no shell of the request's, stdin
// given or closed, killed at its timeout; it resolves what it printed and its exit code. Imports nothing of hopper: it is
// installed as plain files.
import { execFile } from 'node:child_process';
import { spawnOf } from './spawn.ts';

export function runArgv(argv: string[], timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { file, args, env } = spawnOf(argv, process.env);
    const child = execFile(file, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: 124, stdout, stderr: `timed out after ${timeoutMs} ms` });
      resolve({ code: typeof e.code === 'number' ? e.code : 127, stdout, stderr: stderr || e.message });
    });
    child.stdin?.on('error', () => undefined); // a script that exits before reading answers its own exit code
    child.stdin?.end(input ?? '');
  });
}
