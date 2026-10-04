// Run `fn` now and every `ms` while the component is mounted; failures are ignored (the next run retries).
import { useEffect } from 'react';

export function usePoll(fn: () => Promise<unknown>, ms: number): void {
  useEffect(() => {
    const run = () => { fn().catch(() => {}); };
    run();
    const t = setInterval(run, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}
