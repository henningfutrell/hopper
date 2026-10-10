// The log mask (issue #685): every line the daemon writes to its log — stdout and stderr, whatever writes them — goes
// through maskLogLine first. A container's log goes to the host's journal and stays there, so a secret written once is
// leaked. The mask holds the master key and its previous keys by value, so a key in a form no pattern knows is masked too.
import type { Writable } from 'node:stream';
import { maskLogLine } from './mask.ts';

export interface LogMask {
  /** Mask each secret by value from now on. An empty one masks nothing. */
  hold(...secrets: string[]): void;
  /** Mask every write to `stream` from now on; a stream already covered is left as it is. */
  cover(stream: Writable): void;
}

type Write = Writable['write'];

export function createLogMask(): LogMask {
  const held = new Set<string>();
  const covered = new WeakSet<Writable>();
  return {
    hold(...secrets) {
      for (const secret of secrets) if (secret) held.add(secret);
    },
    cover(stream) {
      if (covered.has(stream)) return;
      covered.add(stream);
      const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') return write(maskLogLine(chunk, held), ...rest);
        if (chunk instanceof Uint8Array) {
          const text = Buffer.from(chunk).toString('utf8');
          const masked = maskLogLine(text, held);
          return write(masked === text ? chunk : Buffer.from(masked, 'utf8'), ...rest);
        }
        return write(chunk, ...rest);
      }) as Write;
    },
  };
}

/** The process's log mask: main() covers stdout and stderr with it; startApp holds the master key in it. */
export const logMask = createLogMask();
