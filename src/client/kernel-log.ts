// Large page allocation failures in the kernel log (issue #2622 part 6, design.md "The allocation failure watch"). A WSL VM
// whose memory is full and fragmented fails the order:7 allocations hv_sock needs (`vmbus_alloc_ring`), and wsl.exe and
// interop hang next. The meter reads /dev/kmsg as it grows (non-blocking, from where it read before; the whole buffer at
// its first read) and keeps each failure of order 4 or more with its time since boot; an ssh target's probe prints dmesg's.
// Counted over the last 10 minutes by /proc/uptime. A kernel log it may not read (dmesg_restrict) says none.
// Imports nothing of hopper: a client target runs it as a plain file.
import { closeSync, constants, openSync, readFileSync, readSync } from 'node:fs';

/** A page allocation failure of this order or more is a large one. */
export const ALLOC_FAILURE_MIN_ORDER = 4;
/** The failures counted are those of the last this many seconds. */
export const ALLOC_FAILURE_WINDOW_S = 600;

/** One page allocation failure the kernel logged: seconds since boot, and its order. */
export interface AllocFailure { atS: number; order: number }
/** The large page allocation failures in the window, and the highest order of them. */
export interface AllocFailures { count: number; maxOrder: number }

const KMSG_FAILURE = /^\d+,\d+,(\d+),[^;]*;.*page allocation failure: order:(\d+)/;

/** The large failures in /dev/kmsg records (`prio,seq,usec,flags;message`; a continuation line starts with a space). */
export function kmsgFailures(text: string): AllocFailure[] {
  return text.split('\n').flatMap((l) => {
    const m = KMSG_FAILURE.exec(l);
    return m && Number(m[2]) >= ALLOC_FAILURE_MIN_ORDER ? [{ atS: Number(m[1]) / 1e6, order: Number(m[2]) }] : [];
  });
}

/** Of the failures, those in the window before `uptimeS`; undefined when none. */
export function allocFailuresIn(failures: readonly AllocFailure[], uptimeS: number): AllocFailures | undefined {
  const recent = failures.filter((f) => f.order >= ALLOC_FAILURE_MIN_ORDER && f.atS <= uptimeS && uptimeS - f.atS <= ALLOC_FAILURE_WINDOW_S);
  return recent.length ? { count: recent.length, maxOrder: Math.max(...recent.map((f) => f.order)) } : undefined;
}

/** The seconds since boot /proc/uptime says; undefined when it cannot be read. */
export function uptimeOf(text: string | undefined): number | undefined {
  const v = Number(/^\s*(\d+(?:\.\d+)?)\s/.exec(text ?? '')?.[1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** A reader of the kernel log at `kmsg`, with `/proc/uptime` at `uptime`: each call reads what was added and counts the window. */
export function allocFailureReader(kmsg: string, uptime: string): () => AllocFailures | undefined {
  let fd: number | undefined;
  let closed = false;
  let kept: AllocFailure[] = [];
  let rest = '';
  const buf = Buffer.alloc(16_384);
  const readNew = (): string => {
    if (closed) return '';
    try {
      fd ??= openSync(kmsg, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      closed = true;
      return '';
    }
    let out = '';
    // /dev/kmsg gives one record per read and EAGAIN at its end (EPIPE when records were overwritten: read on); a file, 0.
    for (let reads = 0; reads < 100_000; reads += 1) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPIPE') continue;
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') { closeSync(fd); fd = undefined; closed = true; }
        break;
      }
      if (n === 0) break;
      out += buf.toString('utf8', 0, n);
    }
    return out;
  };
  return () => {
    const now = (() => { try { return uptimeOf(readFileSync(uptime, 'utf8')); } catch { return undefined; } })();
    // A file (a test's) may end a read inside a line: it waits for the rest.
    const text = rest + readNew();
    const cut = text.lastIndexOf('\n') + 1;
    rest = text.slice(cut);
    const added = kmsgFailures(text.slice(0, cut));
    if (now === undefined) return undefined;
    kept = [...kept, ...added].filter((f) => now - f.atS <= ALLOC_FAILURE_WINDOW_S);
    return allocFailuresIn(kept, now);
  };
}
