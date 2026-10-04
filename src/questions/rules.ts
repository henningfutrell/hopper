// The rules file: the owner's standing rules, given to the answerer and the assessor. Read on every
// ask, so an edit (by hand or from the UI) applies to the next question without a restart. A UI
// edit replaces it atomically against the version it was read at (issue #18).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RulesFileView } from '../domain/types.ts';

export interface Rules {
  text: string;
  /** True when the file could not be read; the prompt and the attempt reason say so. */
  missing: boolean;
}

/** The most a UI edit may write: rules go into every answerer and assessor prompt. */
export const RULES_FILE_MAX_BYTES = 64 * 1024;

const resolve = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** Read on every ask, so edits apply to the next question. Unreadable → empty, flagged. */
export function readRulesFile(path: string): Rules {
  try {
    return { text: readFileSync(resolve(path), 'utf8'), missing: false };
  } catch {
    return { text: '', missing: true };
  }
}

/** The rules file as the UI reads it; `version` is the sha-256 of its bytes. Unreadable reads as missing, as for a question. */
export function rulesFileView(path: string): RulesFileView {
  const file = resolve(path);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return { path: file, text: '', version: 'missing', missing: true }; }
  return { path: file, text: bytes.toString('utf8'), version: createHash('sha256').update(bytes).digest('hex'), missing: false };
}

export type RulesFileEdit = { ok: true; view: RulesFileView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/**
 * Replace the rules file with `text` if it is still at `version`: a temp file beside it, renamed
 * over it, keeping the file's mode (600 for a new one).
 */
export function writeRulesFile(path: string, text: string, version: string): RulesFileEdit {
  const file = resolve(path);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > RULES_FILE_MAX_BYTES) return { ok: false, code: 'invalid', error: `the rules file may hold at most 64 KiB; this is ${bytes} bytes` };
  if (rulesFileView(file).version !== version) return { ok: false, code: 'conflict', error: `${file} changed since it was read; reload and edit again` };
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); }
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return { ok: true, view: rulesFileView(file) };
}
