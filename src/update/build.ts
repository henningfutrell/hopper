// The production builder: the target's own scripts/install.sh in build-only mode builds the install
// (UI bundle, production dependencies, install.json) into a directory beside the running one, and
// touches nothing else — no service, no config. Its output goes to <dataDir>/update/build.log.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateBuilder } from '../domain/ports.ts';

const STAGE_TIMEOUT_MS = 20 * 60_000;

export function createInstallScriptBuilder(o: { logFile: string }): UpdateBuilder {
  return {
    build(sourceDir, targetDir, info) {
      mkdirSync(dirname(o.logFile), { recursive: true });
      const log = createWriteStream(o.logFile);
      return new Promise((resolve, reject) => {
        const child = spawn('bash', [join(sourceDir, 'scripts', 'install.sh')], {
          cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: STAGE_TIMEOUT_MS,
          env: {
            ...process.env, HOPPER_INSTALL_INTO: targetDir,
            HOPPER_INSTALL_REPO: info.repo, HOPPER_INSTALL_BRANCH: info.branch, HOPPER_INSTALL_COMMIT: info.commit,
          },
        });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        child.on('error', (e) => { log.end(); reject(e); });
        child.on('close', (code, signal) => {
          log.end(() => {
            if (code === 0) return resolve();
            const tail = readFileSync(o.logFile, 'utf8').trim().split('\n').slice(-3).join(' | ');
            reject(new Error(`install.sh (build-only) exited ${code ?? signal}: ${tail} (full log: ${o.logFile})`));
          });
        });
      });
    },
  };
}
