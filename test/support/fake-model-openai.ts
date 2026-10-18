// The OpenAI side of the fake model server (issue #1958): the Responses API (codex) and the Chat Completions API (an
// OpenAI-compatible provider: opencode, omp), a step as one answer or as its streamed events, in the shapes
// https://platform.openai.com/docs/api-reference/responses-streaming and /chat/streaming give.
import { DROPPED, MALFORMED_BODY, nextId, pieces, type Answer } from './fake-model-anthropic.ts';
import type { ModelStep } from './fake-model-server.ts';

const MALFORMED = 'data: {"type":"response.output_text.delta","delta":\n\n';

function faultAnswer(step: ModelStep): Answer | undefined {
  const fault = 'fault' in step ? step.fault : undefined;
  const error = (status: number, type: string, message: string, headers?: Record<string, string>): Answer =>
    ({ status, json: { error: { type, code: type, message } }, ...(headers ? { headers } : {}) });
  if (fault === 'rate-limited') return error(429, 'rate_limit_exceeded', 'Rate limit reached', { 'retry-after': '0' });
  if (fault === 'overloaded') return error(503, 'server_is_overloaded', 'The server is overloaded');
  if (fault === 'server-error') return error(500, 'server_error', step.text ?? 'Internal server error');
  return undefined;
}

const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 };

export function responsesAnswer(step: ModelStep, body: Record<string, unknown>, stream: boolean): Answer {
  const failed = faultAnswer(step);
  if (failed) return failed;
  const fault = 'fault' in step ? step.fault : undefined;
  const model = typeof body.model === 'string' ? body.model : 'fake-model';
  const id = nextId('resp');
  const text = step.text ?? '';
  const items: Record<string, unknown>[] = [];
  if (text) items.push({ type: 'message', id: nextId('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  if ('tool' in step) items.push({ type: 'function_call', id: nextId('fc'), call_id: nextId('call'), name: step.tool.name, arguments: JSON.stringify(step.tool.input), status: 'completed' });
  const response = (status: string, output: unknown[]) => ({ id, object: 'response', created_at: 1, model, status, output, usage: status === 'completed' ? usage : null });
  if (!stream && fault === 'malformed') return MALFORMED_BODY;
  if (!stream && fault === 'cut') return DROPPED;
  if (!stream) return { status: 200, json: response('completed', items) };
  let seq = 0;
  const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
  const events = [ev('response.created', { response: response('in_progress', []) }), ev('response.in_progress', { response: response('in_progress', []) })];
  items.forEach((item, output_index) => {
    if (item.type === 'message') {
      events.push(ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } }));
      events.push(ev('response.content_part.added', { output_index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
      const parts = pieces(text);
      parts.forEach((delta, i) => {
        if (fault === 'malformed' && i === Math.floor(parts.length / 2)) events.push(MALFORMED);
        else events.push(ev('response.output_text.delta', { output_index, item_id: item.id, content_index: 0, delta }));
      });
      events.push(ev('response.output_text.done', { output_index, item_id: item.id, content_index: 0, text }));
      events.push(ev('response.content_part.done', { output_index, item_id: item.id, content_index: 0, part: { type: 'output_text', text, annotations: [] } }));
    } else {
      events.push(ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } }));
      events.push(ev('response.function_call_arguments.delta', { output_index, item_id: item.id, delta: item.arguments }));
      events.push(ev('response.function_call_arguments.done', { output_index, item_id: item.id, arguments: item.arguments }));
    }
    // codex reads the whole item from this event, not from the deltas: the malformed fault breaks it too.
    events.push(fault === 'malformed' && item.type === 'message' ? MALFORMED : ev('response.output_item.done', { output_index, item }));
  });
  events.push(ev('response.completed', { response: response('completed', items) }));
  if (fault === 'cut') return { events: events.slice(0, 5), cut: true };
  return { events, ...('delayMs' in step && step.delayMs ? { delayMs: step.delayMs } : {}) };
}

export function chatAnswer(step: ModelStep, body: Record<string, unknown>, stream: boolean): Answer {
  const failed = faultAnswer(step);
  if (failed) return failed;
  const fault = 'fault' in step ? step.fault : undefined;
  const model = typeof body.model === 'string' ? body.model : 'fake-model';
  const id = nextId('chatcmpl');
  const text = step.text ?? '';
  const call = 'tool' in step ? { id: nextId('call'), type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.input) } } : undefined;
  const finish = call ? 'tool_calls' : 'stop';
  const chatUsage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (!stream && fault === 'malformed') return MALFORMED_BODY;
  if (!stream && fault === 'cut') return DROPPED;
  if (!stream) {
    const message = { role: 'assistant', content: text || null, ...(call ? { tool_calls: [call] } : {}) };
    return { status: 200, json: { id, object: 'chat.completion', created: 1, model, choices: [{ index: 0, message, finish_reason: finish }], usage: chatUsage } };
  }
  const chunk = (delta: object, finish_reason: string | null, extra: object = {}): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
  const events = [chunk({ role: 'assistant', content: '' }, null)];
  if ('thinking' in step && step.thinking) events.push(chunk({ reasoning_content: step.thinking }, null));
  const parts = text ? pieces(text) : [];
  parts.forEach((content, i) => {
    if (fault === 'malformed' && i === Math.floor(parts.length / 2)) events.push('data: {"id":\n\n');
    else events.push(chunk({ content }, null));
  });
  if (call) events.push(chunk({ tool_calls: [{ index: 0, ...call }] }, null));
  events.push(chunk({}, finish, { usage: chatUsage }));
  events.push('data: [DONE]\n\n');
  if (fault === 'cut') return { events: events.slice(0, 2), cut: true };
  return { events, ...('delayMs' in step && step.delayMs ? { delayMs: step.delayMs } : {}) };
}
