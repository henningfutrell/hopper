// Issue #1169 part 4: a job's transcript, read from the agent session its checkpoint keeps. Each prompt starts a turn;
// the agent's text, its reasoning and its tool calls with their results are the turn's parts, in order. A plan
// (TodoWrite) is a plan, a subagent (Task, Agent) a subagent; a subagent's own lines (sidechain) and the session's
// bookkeeping lines are not shown. Long text is cut, and says so. A page is the newest turns before a turn.
//
// Feature: the job's transcript
//   Scenario: prompts start turns, and a tool call gets its result
//   Scenario: a plan and a subagent are parts of their own
//   Scenario: long text is cut
//   Scenario: a page is the newest turns before a turn
import { describe, expect, it } from 'vitest';
import { parseTranscript, transcriptPage, TRANSCRIPT_TOOL_MAX } from '../../src/domain/transcript.ts';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: '2026-10-14T12:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => line({ type: 'assistant', timestamp: '2026-10-14T12:00:01.000Z', message: { role: 'assistant', content }, ...extra });

describe('a job\'s transcript', () => {
  it('starts a turn at each prompt, and gives a tool call its result', () => {
    const session = [
      line({ type: 'summary', summary: 'Painting' }),
      user('Paint the shed'),
      assistant([{ type: 'thinking', thinking: 'Blue is best.' }, { type: 'text', text: 'I paint it blue.' }]),
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'paint --blue', description: 'Paint it' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'painted' }]),
      assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'shed.txt' } }]),
      user([{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'no such file' }], is_error: true }]),
      user('Now the door', { isMeta: true }),
      user([{ type: 'text', text: 'Now the door' }]),
      assistant([{ type: 'text', text: 'Done.' }]),
      'not json',
    ].join('\n');

    const turns = parseTranscript(session);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({
      index: 0, at: '2026-10-14T12:00:00.000Z', prompt: 'Paint the shed',
      parts: [
        { kind: 'reasoning', text: 'Blue is best.' },
        { kind: 'text', text: 'I paint it blue.' },
        { kind: 'tool', id: 't1', name: 'Bash', title: 'Paint it', input: 'paint --blue', result: 'painted' },
        { kind: 'tool', id: 't2', name: 'Read', title: 'shed.txt', input: JSON.stringify({ file_path: 'shed.txt' }, null, 2), result: 'no such file', error: true },
      ],
    });
    expect(turns[1]).toMatchObject({ index: 1, prompt: 'Now the door', parts: [{ kind: 'text', text: 'Done.' }] });
  });

  it('makes a plan and a subagent parts of their own, and leaves out a subagent\'s own lines', () => {
    const session = [
      assistant([{ type: 'text', text: 'Before any prompt.' }]),
      user('Paint the shed'),
      assistant([{ type: 'tool_use', id: 'p1', name: 'TodoWrite', input: { todos: [{ content: 'Sand', status: 'completed' }, { content: 'Paint', status: 'in_progress' }, { content: 'Dry', status: 'pending' }] } }]),
      user([{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }]),
      assistant([{ type: 'tool_use', id: 's1', name: 'Task', input: { description: 'Find the brush', prompt: 'Look in the garage', subagent_type: 'Explore' } }]),
      assistant([{ type: 'text', text: 'Inside the subagent.' }], { isSidechain: true }),
      user([{ type: 'tool_result', tool_use_id: 's1', content: 'In the garage.' }]),
    ].join('\n');

    const turns = parseTranscript(session);
    expect(turns.map((t) => t.prompt)).toEqual([undefined, 'Paint the shed']);
    expect(turns[1]!.parts).toEqual([
      { kind: 'plan', id: 'p1', items: [{ text: 'Sand', status: 'completed' }, { text: 'Paint', status: 'in_progress' }, { text: 'Dry', status: 'pending' }] },
      { kind: 'subagent', id: 's1', name: 'Task', title: 'Find the brush', agent: 'Explore', prompt: 'Look in the garage', result: 'In the garage.' },
    ]);
  });

  it('cuts a long tool result, and says so', () => {
    const session = [
      user('Read it'),
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(TRANSCRIPT_TOOL_MAX + 10) }]),
    ].join('\n');
    const tool = parseTranscript(session)[0]!.parts[0]!;
    expect(tool).toMatchObject({ kind: 'tool', title: 'cat big', truncated: true });
    expect((tool as { result: string }).result).toHaveLength(TRANSCRIPT_TOOL_MAX);
  });

  it('pages the newest turns before a turn', () => {
    const session = Array.from({ length: 5 }, (_, i) => user(`prompt ${i}`)).join('\n');
    const turns = parseTranscript(session);
    expect(transcriptPage(turns, { limit: 2 })).toEqual({ total: 5, start: 3, turns: [turns[3], turns[4]] });
    expect(transcriptPage(turns, { before: 3, limit: 2 })).toEqual({ total: 5, start: 1, turns: [turns[1], turns[2]] });
    expect(transcriptPage(turns, { before: 1, limit: 2 })).toEqual({ total: 5, start: 0, turns: [turns[0]] });
  });
});
