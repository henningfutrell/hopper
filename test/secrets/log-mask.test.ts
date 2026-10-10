// Issue #685: every line the daemon writes to its log goes through the secret mask, whatever writes it — the start
// lines, a part's console line, an error's stack. The master key (and its previous keys) are held by value, so a key in
// a form no pattern knows is masked too.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogMask } from '../../src/secrets/log-mask.ts';

/** A stream that keeps what is written to it. */
function sink(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk: Buffer, _enc, done) { chunks.push(chunk.toString('utf8')); done(); } });
  return { stream, text: () => chunks.join('') };
}

describe('the log mask', () => {
  it('masks a held secret, a key pattern and a GitHub token in each line written to a masked stream', () => {
    const mask = createLogMask();
    const out = sink();
    mask.cover(out.stream);
    const held = 'xY'.repeat(22);
    mask.hold(held);
    const hex = randomBytes(32).toString('hex');
    out.stream.write(`one ${held}\n`);
    out.stream.write(Buffer.from(`two ${hex}\n`));
    out.stream.write(`three ghs_${'aB3'.repeat(12)}\n`);
    const text = out.text();
    expect(text).not.toContain(held);
    expect(text).not.toContain(hex);
    expect(text).toContain('one [secret, masked]\n');
    expect(text).toContain('two [key, masked]\n');
    expect(text).not.toContain('aB3aB3aB3');
  });

  it('holds no empty secret, and covers a stream once', () => {
    const mask = createLogMask();
    const out = sink();
    mask.cover(out.stream);
    mask.cover(out.stream);
    mask.hold('');
    out.stream.write('plain line\n');
    expect(out.text()).toBe('plain line\n');
  });

  it('calls the write callback of a masked write', async () => {
    const mask = createLogMask();
    const out = sink();
    mask.cover(out.stream);
    await new Promise<void>((resolve, reject) => { out.stream.write('done?\n', (e) => (e ? reject(e) : resolve())); });
    expect(out.text()).toBe('done?\n');
  });
});
