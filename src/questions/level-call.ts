// One escalation level's call (design.md "Question pipeline"): aborted by cancel, a human answer, shutdown, or the stage
// timeout; a throw is an error. `inflight` holds its abort controller while it runs, so the service can abort it.

/** Runs `fn` for question `id`; past `timeoutMs` it is aborted and counts as an error. */
export async function callLevel<T>(inflight: Map<string, AbortController>, id: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | { error: string }> {
  const ac = new AbortController();
  inflight.set(id, ac);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => {
      ac.abort('timeout');
      resolve({ error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac.signal).catch((e: unknown) => ({ error: `threw: ${e instanceof Error ? e.message : String(e)}` })), timeout]);
  } finally {
    clearTimeout(timer);
    if (inflight.get(id) === ac) inflight.delete(id);
  }
}
