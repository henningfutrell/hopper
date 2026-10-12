// Out-of-band changes on Infra changes (issue #871, design.md "Out-of-band changes"), pure: one line per change — where it
// was found, what changed and who did it —, its state now, and the controller identities as a person types them.
import type { OutOfBandView } from '../../../src/domain/types.ts';

const FOUND_IN: Record<OutOfBandView['source'], string> = {
  gitops: 'GitOps drift', 'terraform-plan': 'Terraform drift', cloudtrail: 'CloudTrail', 'kube-audit': 'Kubernetes audit log',
};

export const changeHeadline = (c: Omit<OutOfBandView, 'marked'>): string =>
  `${FOUND_IN[c.source]}: ${c.what} on ${c.target}${c.who ? `, by ${c.who}` : ''}`;

/** Who reported a change: the job whose check found it, or an outside collector by its API token's label. */
export const reportedBy = (c: Pick<OutOfBandView, 'job' | 'reporter'>): string =>
  (c.job ? `reported by job ${c.job.slice(0, 8)}` : `reported by ${c.reporter ?? 'an unknown reporter'}`);

export type ChangeState = { kind: 'open' | 'marked'; words: string };

const MARKED = { adopted: 'Adopted into git', reverted: 'Reverted', accepted: 'Accepted' } as const;

/** Open until a person marks it; then the mark, who set it, and the reason. */
export function changeState(c: OutOfBandView): ChangeState {
  if (!c.marked) return { kind: 'open', words: 'Waits for a person: adopt it into git, revert it, or accept it with a reason' };
  const { mark, by, reason } = c.marked;
  return { kind: 'marked', words: `${MARKED[mark]} by ${by}${reason ? `: ${reason}` : ''}` };
}

/** The controller identities in a text a person typed: one per line, blank lines dropped. */
export const controllersFrom = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
