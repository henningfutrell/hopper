// A call to Jev with a ceiling (issue #550): past `ms` the call is aborted and `late` is the answer; a throw is `late`
// with the error's words. Jev's own failures are answers already, so this never throws.

export async function withDeadline<T>(ms: number, call: (signal: AbortSignal) => Promise<T>, late: T & { ok: false; why: string }): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ac = new AbortController();
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => { ac.abort(); resolve(late); }, ms); });
  try {
    return await Promise.race([call(ac.signal).catch((e: unknown) => ({ ...late, why: e instanceof Error ? e.message : String(e) })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
