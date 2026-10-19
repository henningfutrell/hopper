// Issue #1154: a checkpoint's parts are scrubbed of secrets and compressed again in a worker thread, so a long agent
// session does not hold the hopper's event loop. The worker's answer is the same as the scrub done in place.
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { scrubCheckpoint, scrubParts } from '../../src/engine/checkpoint-scrub.ts';

const GH = `ghp_${'a1B2'.repeat(9)}`;
const session = [JSON.stringify({ type: 'user', message: { content: `export GH_TOKEN=${GH}` } }), 'plain line', ''].join('\n');
const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', `-old ${GH}`, `+new ${GH}`, ''].join('\n');
const taken = { patch: gzipSync(Buffer.from(patch, 'latin1')), session: gzipSync(Buffer.from(session, 'utf8')) };

describe('scrubbing a checkpoint off the event loop', () => {
  it('answers what the scrub in place answers', async () => {
    const off = await scrubCheckpoint(taken);
    const here = scrubParts(taken);
    expect(gunzipSync(off.patch).toString('latin1')).toBe(gunzipSync(here.patch).toString('latin1'));
    expect(gunzipSync(off.session!).toString('utf8')).toBe(gunzipSync(here.session!).toString('utf8'));
  });

  it('masks the secrets the session and the lines the patch adds hold; a removed line stays the base\'s', async () => {
    const off = await scrubCheckpoint(taken);
    const p = gunzipSync(off.patch).toString('latin1');
    expect(p).toContain(`-old ${GH}`);
    expect(p).not.toContain(`+new ${GH}`);
    expect(gunzipSync(off.session!).toString('utf8')).not.toContain(GH);
  });

  it('masks by value each vault secret delivered to the job (issue #1957), which no pattern knows', async () => {
    const held = 'correct horse battery';
    const parts = {
      patch: gzipSync(['--- a/x', '+++ b/x', `-old ${held}`, `+pw=${held}`, ''].join('\n')),
      session: gzipSync(`${JSON.stringify({ message: `it printed ${held}` })}\nplain ${held}\n`),
      held: [held],
    };
    const off = await scrubCheckpoint(parts);
    expect(gunzipSync(off.patch).toString('latin1')).toBe(['--- a/x', '+++ b/x', `-old ${held}`, '+pw=[vault secret, masked]', ''].join('\n'));
    expect(gunzipSync(off.session!).toString('utf8')).toBe(`${JSON.stringify({ message: 'it printed [vault secret, masked]' })}\nplain [vault secret, masked]\n`);
    expect(gunzipSync(scrubParts(parts).session!).toString('utf8')).not.toContain(held);
  });

  it('a checkpoint with no session answers none', async () => {
    const off = await scrubCheckpoint({ patch: taken.patch });
    expect(off.session).toBeUndefined();
  });

  it('rejects a part that is not gzip', async () => {
    await expect(scrubCheckpoint({ patch: Buffer.from('not gzip') })).rejects.toThrow();
  });
});
