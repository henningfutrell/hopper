/**
 * Runs one Decision at a time. A trigger arriving mid-decision is kept (the first one wins)
 * and runs once the current one ends; further triggers coalesce into it.
 */
export interface Serial {
  trigger(reason: string): void;
  /** Resolves when nothing is running or pending. */
  idle(): Promise<void>;
  close(): void;
}

export function createSerial(run: (reason: string) => Promise<void>, onError: (e: unknown) => void): Serial {
  let current: Promise<void> | undefined;
  let pending: string | undefined;
  let closed = false;

  const start = (reason: string): void => {
    current = run(reason)
      .catch(onError)
      .finally(() => {
        current = undefined;
        const next = pending;
        pending = undefined;
        if (next !== undefined && !closed) start(next);
      });
  };

  return {
    trigger(reason) {
      if (closed) return;
      if (current) pending ??= reason;
      else start(reason);
    },
    async idle() {
      while (current) await current;
    },
    close() {
      closed = true;
      pending = undefined;
    },
  };
}
