// A minimal SSE client over fetch: parses `id:` / `event:` / `data:` frames and comments.

export interface SseMessage { id?: string; event: string; data: string }

export interface SseClient {
  messages: SseMessage[];
  comments: string[];
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
  if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`);
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
    throw new Error(`SSE content-type: ${res.headers.get('content-type')}`);
  }
  const client: SseClient = { messages: [], comments: [], close: () => ac.abort() };
  const decoder = new TextDecoder();
  let buffer = '';
  const parseFrame = (frame: string): void => {
    const msg: SseMessage = { event: 'message', data: '' };
    let hasData = false;
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) client.comments.push(line.slice(1).trim());
      else if (line.startsWith('id:')) msg.id = line.slice(3).trim();
      else if (line.startsWith('event:')) msg.event = line.slice(6).trim();
      else if (line.startsWith('data:')) { msg.data += line.slice(5).trim(); hasData = true; }
    }
    if (hasData) client.messages.push(msg);
  };
  void (async () => {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          parseFrame(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return client;
}
