// The pseudo-terminal (issue #189): node-pty, the library VS Code's terminal runs on. A real tty, so
// herdr's TUI draws, reads keys and follows the browser's size like in any terminal emulator.
import { spawn } from 'node-pty';
import type { SpawnTerminal } from '../domain/ports.ts';

export const spawnTerminal: SpawnTerminal = (o) => {
  const p = spawn(o.file, o.args, { name: o.env.TERM ?? 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
  return {
    write: (data) => p.write(data),
    resize: (cols, rows) => p.resize(cols, rows),
    onData: (listener) => { p.onData(listener); },
    onExit: (listener) => { p.onExit((e) => listener(e.exitCode)); },
    kill: () => {
      try { p.kill(); } catch { /* already gone */ }
    },
  };
};
