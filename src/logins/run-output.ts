// A print-mode run's output, watched for a device code as it comes (issue #476): an agent CLI run by an executor,
// or an escalation level's claude. A code the output shows is reported to the logins while the run waits on it,
// once per code; when the run ends, the login is completed (the run succeeded) or failed (it did not). A
// print-mode run cannot be asked for a new code: its tool takes no input.
import type { Clock, RunLogins } from '../domain/ports.ts';
import { hideCodes, recogniseDeviceCode } from './recognise.ts';

/** The tail of the output the recognisers read: a prompt is a few lines, and a long run's output is long. */
const KEPT_CHARS = 16_000;

export interface RunOutputWatch {
  /** More of the run's output, stdout or stderr. */
  feed(chunk: string): void;
  /** The run ended: `ok`, or why not. */
  end(outcome: { ok: true } | { ok: false; reason: string }): void;
  /** The codes reported so far, to hide them wherever the run's output goes. */
  codes(): string[];
}

export function watchRunOutput(logins: RunLogins | undefined, clock: Clock, onProblem: (line: string) => void = () => {}): RunOutputWatch {
  let tail = '';
  let id: string | undefined;
  const codes: string[] = [];
  return {
    feed(chunk) {
      if (!logins) return;
      tail = (tail + chunk).slice(-KEPT_CHARS);
      const p = recogniseDeviceCode(tail);
      if (!p || codes.includes(p.userCode)) return;
      codes.push(p.userCode);
      try {
        id = logins.report({
          kind: 'device_code', tool: p.tool, verificationUrl: p.verificationUrl, userCode: p.userCode,
          expiresAt: new Date(clock.now().getTime() + p.expiresInSec * 1000).toISOString(),
        }, { renewable: false });
      } catch (e) {
        onProblem(`a ${p.tool} device login could not be reported: ${(e as Error).message}`);
      }
    },
    end(outcome) {
      if (!logins || id === undefined) return;
      if (outcome.ok) logins.completed(id);
      else logins.failed(id, `the run ended: ${hideCodes(outcome.reason, outcome.reason, codes)}`);
    },
    codes: () => [...codes],
  };
}
