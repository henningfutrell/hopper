// What this process spawned while a test ran (issue #1957): each tool's file, argv and environment, as the child got
// them. A child the hopper starts (git, ssh, tar, a box's runtime) is a place a secret can leak to — its argv is in
// every `ps`, its environment in /proc — so the canary scan reads them. An async child is recorded where every one goes
// through (`ChildProcess.prototype.spawn`, with its final environment); a sync one at the exports, made live for the
// ES modules that import them by `syncBuiltinESMExports`. Children of a worker thread are not seen.
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/** One child: its file, argv and environment. */
export interface Spawned { file: string; argv: string[]; env: string[] }

const SYNC = ['spawnSync', 'execFileSync', 'execSync'] as const;

type Options = { env?: NodeJS.ProcessEnv } | undefined;
const envOf = (o: Options): string[] => Object.entries(o?.env ?? process.env).map(([k, v]) => `${k}=${String(v)}`);

/** Records every child spawned from now until `stop()`. */
export function recordSpawns(): { spawned: Spawned[]; stop: () => void } {
  const spawned: Spawned[] = [];
  const cp = childProcess as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = ChildProcess.prototype as unknown as { spawn: (o: { file: string; args: string[]; envPairs?: string[] }) => unknown };
  const spawn = proto.spawn;
  proto.spawn = function (this: unknown, o) {
    spawned.push({ file: o.file, argv: [...o.args], env: [...(o.envPairs ?? [])] });
    return spawn.call(this, o);
  };
  const sync = Object.fromEntries(SYNC.map((n) => [n, cp[n]!]));
  for (const n of SYNC) {
    cp[n] = (file: unknown, ...rest: unknown[]) => {
      const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : [];
      const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as Options;
      spawned.push({ file: String(file), argv: [String(file), ...args], env: envOf(options) });
      return sync[n]!(file, ...rest);
    };
  }
  syncBuiltinESMExports();
  return {
    spawned,
    stop: () => {
      proto.spawn = spawn;
      for (const n of SYNC) cp[n] = sync[n]!;
      syncBuiltinESMExports();
    },
  };
}
