// Deterministic polling: every integration assertion about asynchronous state goes through here.

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false | null> | T | undefined | false | null,
  o: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const timeoutMs = o.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    last = await probe();
    if (last !== undefined && last !== false && last !== null) return last as T;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${o.what ?? 'condition'}`);
    }
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 20));
  }
}
