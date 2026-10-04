// One shared 1 s clock: every ticking label reads it, one interval drives them all.
import { useSyncExternalStore } from 'react';

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  timer ??= setInterval(() => { now = Date.now(); for (const l of listeners) l(); }, 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
  };
}

export const useNow = (): number => useSyncExternalStore(subscribe, () => now);
