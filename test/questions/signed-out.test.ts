// Not-signed-in questions answered by a tool sign-in (issue #1128): only the open ones of Claude's prompt on the machine
// the sign-in completed on; a login screen's question, another machine's, another tool's sign-in, a closed one: none.
import { describe, expect, it } from 'vitest';
import { LOGIN_SCREEN_MARK, NOT_SIGNED_IN, SIGNED_IN_ANSWER, SIGNED_IN_BY, type Question } from '../../src/domain/types.ts';
import { answerSignedOut } from '../../src/questions/index.ts';

const question = (id: string, text: string, machineId: string, status: Question['status'] = 'open'): Question =>
  ({ id, jobId: `job-${id}`, text, status, raisedBy: { machineId } }) as Question;

const QUESTIONS = [
  question('prompt', `${NOT_SIGNED_IN}.\n\n❯ `, 'studio'),
  question('login-screen', `${NOT_SIGNED_IN}.\n\n${LOGIN_SCREEN_MARK}\n ❯ 1. Claude account with subscription`, 'studio'),
  question('elsewhere', `${NOT_SIGNED_IN}.\n\n❯ `, 'wsl'),
  question('other', 'Is this risky?', 'studio'),
  question('answered', `${NOT_SIGNED_IN}.\n\n❯ `, 'studio', 'answered'),
];

function setup() {
  const settled: [string, string, string, string][] = [];
  const store = { questions: { list: ({ status }: { status?: string[] } = {}) => QUESTIONS.filter((q) => !status || status.includes(q.status)) } };
  const questions = { settleWith: (id: string, answer: string, by: string, reason: string) => { settled.push([id, answer, by, reason]); return QUESTIONS.find((q) => q.id === id); } };
  return { settled, deps: { store, questions } as unknown as Parameters<typeof answerSignedOut>[0] };
}

describe('answerSignedOut (issue #1128)', () => {
  it('answers the open not-signed-in question of Claude\'s prompt on the machine, with the login on its trail', () => {
    const { settled, deps } = setup();
    expect(answerSignedOut(deps, { machineId: 'studio', tool: 'claude', loginId: 'l1' }).map((q) => q.id)).toEqual(['prompt']);
    expect(settled).toEqual([['prompt', SIGNED_IN_ANSWER, SIGNED_IN_BY, 'the claude sign-in from the hopper completed on studio (login l1)']]);
  });

  it('another tool\'s sign-in answers nothing', () => {
    const { settled, deps } = setup();
    expect(answerSignedOut(deps, { machineId: 'studio', tool: 'codex', loginId: 'l1' })).toEqual([]);
    expect(settled).toEqual([]);
  });
});
