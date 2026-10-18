// The Anthropic Messages API side of the fake model server (issue #1958): a step as a message, or as the server-sent
// events of a streamed one (message_start, content blocks with their deltas, message_delta, message_stop), in the
// shapes https://docs.anthropic.com/en/api/messages-streaming gives.
import type { ModelStep } from './fake-model-server.ts';

/** What the server writes: a JSON body, or events, with a delay before each and a cut at their end. */
export type Answer =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; raw: string }
  | { drop: true }
  | { events: string[]; delayMs?: number; cut?: boolean };

let ids = 0;
export const nextId = (prefix: string): string => `${prefix}_fake${++ids}`;

/** The text in pieces of a few characters, as a model streams it. */
export function pieces(text: string): string[] {
  return text.match(/[\s\S]{1,8}/g) ?? [''];
}

/** An answer's body that is not JSON: the malformed fault where no stream was asked for. */
export const MALFORMED_BODY: Answer = { status: 200, raw: '{"id":' };
/** The cut fault where no stream was asked for: the connection ends with no answer. */
export const DROPPED: Answer = { drop: true };

const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`;

const errorOf = (type: string, message: string, status: number, headers?: Record<string, string>): Answer =>
  ({ status, json: { type: 'error', error: { type, message } }, ...(headers ? { headers } : {}) });

export function anthropicAnswer(step: ModelStep, body: Record<string, unknown>, stream: boolean): Answer {
  const model = typeof body.model === 'string' ? body.model : 'fake-model';
  const fault = 'fault' in step ? step.fault : undefined;
  if (fault === 'rate-limited') return errorOf('rate_limit_error', 'Number of requests has exceeded your rate limit', 429, { 'retry-after': '0' });
  if (fault === 'overloaded') return errorOf('overloaded_error', 'Overloaded', 529);
  if (fault === 'server-error') return errorOf('api_error', step.text ?? 'Internal server error', 500);
  const text = step.text ?? '';
  const blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[] = [];
  if (text) blocks.push({ type: 'text', text });
  if ('tool' in step) blocks.push({ type: 'tool_use', id: nextId('toolu'), name: step.tool.name, input: step.tool.input });
  const stop = 'tool' in step ? 'tool_use' : 'end_turn';
  const id = nextId('msg');
  const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // A CLI that falls back to an answer that is not streamed meets the fault there too.
  if (!stream && fault === 'malformed') return MALFORMED_BODY;
  if (!stream && fault === 'cut') return DROPPED;
  if (!stream) {
    return { status: 200, json: { id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop, stop_sequence: null, usage } };
  }
  const events = [sse('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })];
  const thought = 'thinking' in step && step.thinking ? 1 : 0;
  if (thought && 'thinking' in step) {
    events.push(sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    events.push(sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: step.thinking } }));
    events.push(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'fake-signature' } }));
    events.push(sse('content_block_stop', { index: 0 }));
  }
  blocks.forEach((b, at) => {
    const index = at + thought;
    if (b.type === 'text') {
      events.push(sse('content_block_start', { index, content_block: { type: 'text', text: '' } }));
      const parts = pieces(b.text);
      parts.forEach((p, i) => {
        // A malformed event in place of a delta in the middle of the text: a data line that is not JSON.
        if (fault === 'malformed' && i === Math.floor(parts.length / 2)) events.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":\n\n');
        else events.push(sse('content_block_delta', { index, delta: { type: 'text_delta', text: p } }));
      });
    } else {
      events.push(sse('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }));
      events.push(sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }));
    }
    events.push(sse('content_block_stop', { index }));
  });
  events.push(sse('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }));
  events.push(sse('message_stop', {}));
  // A cut stream: the first delta goes, then the connection ends.
  if (fault === 'cut') return { events: events.slice(0, 3), cut: true };
  return { events, ...('delayMs' in step && step.delayMs ? { delayMs: step.delayMs } : {}) };
}
