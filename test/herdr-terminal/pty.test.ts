// Issue #189: the herdr terminal is an actual terminal — a pseudo-terminal on the hopper's machine
// (node-pty), sized by the browser and resized with it. The real adapter, a real shell.
import { describe, expect, it } from 'vitest';
import { spawnTerminal } from '../../src/herdr-terminal/pty.ts';
import { waitFor } from '../support/wait.ts';

describe('the terminal adapter', () => {
  it('runs its program on a pseudo-terminal of the size asked, and passes input, output, resize and exit', async () => {
    const term = spawnTerminal({ file: 'sh', args: [], env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' }, cwd: process.cwd(), cols: 120, rows: 40 });
    let out = '';
    term.onData((d) => { out += d; });
    let exit: number | undefined;
    term.onExit((code) => { exit = code; });
    term.write('tty; stty size\r');
    await waitFor(() => /\/dev\/pts\/\d+/.test(out) && out.includes('40 120'), 5000);
    term.resize(90, 30);
    term.write('stty size\r');
    await waitFor(() => out.includes('30 90'), 5000);
    term.write('exit 3\r');
    await waitFor(() => exit !== undefined, 5000);
    expect(exit).toBe(3);
  });

  it('kill ends the program', async () => {
    const term = spawnTerminal({ file: 'sh', args: ['-c', 'sleep 30'], env: { PATH: process.env.PATH ?? '' }, cwd: process.cwd(), cols: 80, rows: 24 });
    let exited = false;
    term.onExit(() => { exited = true; });
    term.kill();
    await waitFor(() => exited, 5000);
  });
});
