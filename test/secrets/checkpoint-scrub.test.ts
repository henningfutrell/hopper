// A checkpoint is scrubbed before the hopper keeps it (issue #921): secrets in the agent session's log and in the lines
// the patch adds are masked, and both stay what they were — a session file Claude reads, a patch git applies.
import { describe, expect, it } from 'vitest';
import { maskSecrets, scrubPatch, scrubSessionLog } from '../../src/secrets/mask.ts';

const GH = `ghp_${'a1B2'.repeat(9)}`;
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const ANTHROPIC = `sk-ant-api03-${'xY9_'.repeat(8)}`;
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';

describe('masking secrets in text', () => {
  it('masks GitHub tokens, cloud and API keys, private keys and 32-byte keys', () => {
    const out = maskSecrets(`a ${GH} b ${AWS} c ${ANTHROPIC} d ${KEY} e ${'f'.repeat(64)} f xoxb-1234567890-abcdefghij`);
    for (const s of [GH, AWS, ANTHROPIC, 'b3BlbnNzaC1rZXktdjEAAAAA', 'f'.repeat(64), 'xoxb-1234567890-abcdefghij']) expect(out).not.toContain(s);
    expect(out).toContain('[private key, masked]');
    expect(out).toContain('[AWS access key, masked]');
  });

  it('leaves plain text as it is', () => {
    const text = 'git commit -m "Add the checkpoint" && npm test # 42 passed, sha 3f2a9c1';
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('scrubbing the agent session log', () => {
  it('masks inside each JSON line and keeps every line JSON', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: `export GH_TOKEN=${GH}\nthen go on` } }),
      JSON.stringify({ type: 'tool_result', content: [{ text: `key:\n${KEY}` }], cwd: '/w' }),
      'not json at all',
      '',
    ].join('\n');
    const out = scrubSessionLog(lines).split('\n');
    expect(out).toHaveLength(4);
    expect(() => JSON.parse(out[0]!)).not.toThrow();
    expect(() => JSON.parse(out[1]!)).not.toThrow();
    expect(JSON.parse(out[0]!).message.content).toContain('then go on');
    expect(out.join('\n')).not.toContain(GH);
    expect(out.join('\n')).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out[2]).toBe('not json at all');
  });
});

describe('scrubbing the patch', () => {
  it('masks only the lines the patch adds, so it still applies to its base', () => {
    const patch = [
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1,2 +1,2 @@',
      ` OLD=${AWS}`,
      `-A=1`,
      `+TOKEN=${GH}`,
    ].join('\n');
    const out = scrubPatch(patch).split('\n');
    expect(out[4]).toBe(` OLD=${AWS}`);
    expect(out[6]).not.toContain(GH);
    expect(out[6]!.startsWith('+TOKEN=')).toBe(true);
    expect(out[2]).toBe('+++ b/.env');
  });
});
