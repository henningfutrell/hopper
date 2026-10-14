// The job's terminal (issue #1128): whether the job view offers it, and the keys it has buttons for.
import type { Job, JobStatus } from './wire.ts';

/** The statuses a job holds its pane in (src/engine/terminal.ts): at work, or waiting on a question or its own wait. */
const HOLDS_PANE: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** Whether the job may hold a pane now. A job on an executor with no terminal is refused by the daemon, which says why. */
export const holdsPane = (job: Pick<Job, 'status'>): boolean => HOLDS_PANE.includes(job.status);

/** The keys with a button, as herdr names them, and their labels. */
export const TERMINAL_KEY_BUTTONS: readonly { key: string; label: string }[] = [
  { key: 'enter', label: 'Enter' }, { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' }, { key: 'backspace', label: '⌫' },
  { key: 'up', label: '↑' }, { key: 'down', label: '↓' }, { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'ctrl+c', label: 'Ctrl+C' }, { key: 'ctrl+d', label: 'Ctrl+D' },
];

/** How often an open terminal reads the pane again. */
export const TERMINAL_POLL_MS = 1500;
