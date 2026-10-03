import type { AnswerRequest } from '../domain/ports.ts';

const OUTPUT_LINES = 120;

export const IDLE_HINT =
  'The agent went idle without asking anything, so it may simply have finished. ' +
  'If the job is complete, end your message with JOB_HOPPER_DONE';

const CONTRACT = `Reply with one JSON object only:
{"answer": string, "confident": boolean, "risky": boolean, "reason": string}
"answer" is exactly the text to type to the agent.`;

const RISK_GUIDANCE =
  'Mark "risky": true for anything that deletes, deploys, force-pushes, spends money, ' +
  'touches credentials, sends messages, or is otherwise irreversible. ' +
  'Mark "confident": true only if the standing rules and the context settle the question.';

function lastLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n');
}

function previousSection(req: AnswerRequest): string {
  if (req.previous.length === 0) return '';
  const rows = req.previous.map((a) => {
    const why = a.error ? `error: ${a.error}` : (a.reason ?? 'no reason given');
    return `- ${a.tier}${a.model ? ` (${a.model})` : ''}: ${a.answer ?? '(no answer)'} — ${why}`;
  });
  return `## Earlier attempts (escalated to you)\n${rows.join('\n')}\n\n`;
}

export function buildPrompt(req: AnswerRequest): string {
  const q = req.question;
  const rules = req.rules.trim() === '' ? '(no standing rules file; rely on the context alone)' : req.rules.trim();
  const idle = q.detectedBy === 'idle' ? `## Note\n${IDLE_HINT}\n\n` : '';
  return (
    "You answer on the owner's behalf for an unattended coding agent that has stopped to ask.\n\n" +
    `## Standing rules\n${rules}\n\n` +
    `## Job prompt\n${req.jobPrompt}\n\n` +
    (req.jobGoal ? `## Goal\n${req.jobGoal}\n\n` : '') +
    `## Recent output (last ${OUTPUT_LINES} lines)\n${lastLines(q.recentOutput, OUTPUT_LINES)}\n\n` +
    `## Question\n${q.text}\n\n` +
    previousSection(req) +
    idle +
    `## Guidance\n${RISK_GUIDANCE}\n\n${CONTRACT}\n`
  );
}
