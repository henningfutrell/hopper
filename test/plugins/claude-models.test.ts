// The Claude model options are chosen, not typed (issue #151): claude-cli's `model` and
// gate-router's `model` offer the models the `claude` CLI on PATH lists — its stream-json
// initialize handshake, which makes no model call — against a fake `claude` and the real kit.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import claudeCli from '../../src/plugins/escalation-level/claude-cli/index.ts';
import gateRouter from '../../src/plugins/router/gate-router/index.ts';
import { createDetectionKit } from '../../src/plugins/detect.ts';
import { fakeKit } from './support.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
let dir: string;

/** A kit whose PATH holds only a `claude` that runs the fake. */
function kitWithClaude(env: Record<string, string> = {}) {
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return createDetectionKit({ env: { PATH: dir, FAKE_CLAUDE_OUT: join(dir, 'rec.json'), ...env } });
}
const rec = () => JSON.parse(readFileSync(join(dir, 'rec.json'), 'utf8')) as { argv: string[]; stdin: string };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-models-')); });

describe('Claude model choices', () => {
  it('claude-cli offers the models the CLI lists, by alias, with its name and description', async () => {
    const choices = await claudeCli.choices!(kitWithClaude());
    expect(choices).toEqual({
      model: [
        { value: 'opus', label: 'Opus X', description: 'complex work' },
        { value: 'haiku', label: 'Haiku X', description: 'quick answers' },
      ],
    });
  });

  it('asks through the initialize handshake: no prompt, no model named, nothing kept', async () => {
    await claudeCli.choices!(kitWithClaude());
    const { argv, stdin } = rec();
    expect(argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence']));
    expect(argv).not.toContain('--model');
    expect(JSON.parse(stdin.trim())).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
  });

  it('gate-router offers the same models for model', async () => {
    expect(await gateRouter.choices!(kitWithClaude())).toEqual({
      model: [
        { value: 'opus', label: 'Opus X', description: 'complex work' },
        { value: 'haiku', label: 'Haiku X', description: 'quick answers' },
      ],
    });
  });

  it('no claude, a failing claude, or no models listed: no choices', async () => {
    expect(await claudeCli.choices!(fakeKit({ which: async () => undefined, output: async () => undefined }))).toEqual({});
    expect(await claudeCli.choices!(kitWithClaude({ FAKE_CLAUDE_MODE: 'exit1' }))).toEqual({});
    expect(await claudeCli.choices!(kitWithClaude({ FAKE_CLAUDE_MODELS: '[]' }))).toEqual({});
    expect(await claudeCli.choices!(fakeKit({ output: async () => 'not json\n' }))).toEqual({});
  });
});
