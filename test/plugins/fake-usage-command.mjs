#!/usr/bin/env node
/* global process */
// Fake usage command for the command-usage usage source. $FAKE_USAGE_DIR controls it and records it:
//   out.json    what it prints (default: one session reading and a codex account)
//   exit        its exit code (default 0)
//   calls.jsonl one line per run: { argv, cwd }
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_USAGE_DIR;
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
const read = (name, fallback) => (dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : fallback);
const DEFAULT = JSON.stringify({
  readings: [{ window: 'session', used: 40, limit: 100, unit: '%', resetsAt: '2026-10-03T18:00:00.000Z' }],
  account: { service: 'codex', identity: 'user@example.com', detail: { plan: 'pro' } },
});
process.stdout.write(`${read('out.json', DEFAULT)}\n`);
process.exit(Number(read('exit', '0')));
