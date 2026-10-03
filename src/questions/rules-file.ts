import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Rules {
  text: string;
  /** True when the file could not be read; the prompt and the attempt reason say so. */
  missing: boolean;
}

/** Read on every ask, so edits apply to the next question. Unreadable → empty, flagged. */
export function readRulesFile(path: string): Rules {
  const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  try {
    return { text: readFileSync(resolved, 'utf8'), missing: false };
  } catch {
    return { text: '', missing: true };
  }
}
