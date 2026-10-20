// Infra plans from the command line (issue #2205, design.md "A job waits on an infra plan"): `hopper infra plans` lists the
// plans that wait for a person (GET /api/infra-plans), each with its summary and who approves it, and `--all` every plan
// with its state; `hopper infra approve <id>` is Approve on Infra (POST /ui/api/infra-plans), by its full id or the short
// id the views show. The daemon checks who may approve a plan by its risk, as for a click.
import { parseArgs } from 'node:util';
import { failedChecks, type PlanView } from './domain/infra-plans.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const INFRA_USAGE = `  hopper infra plans [--all]                         the infra plans that wait for a person to approve them, with their summary and
                                                     who approves each; --all: every plan, with its state
  hopper infra approve <plan>                        approve an infra plan, by its id or short id: a job that waits on it goes on`;

const LINE = 'infra plans [--all] | infra approve <plan>';

type PlanState = 'waiting' | 'approved' | 'stale' | 'failed';

/** A plan's state at `now`, as Infra says it: failed a check, approved, stale, or waiting for a person. */
const stateOf = (p: PlanView, now: number): PlanState =>
  (failedChecks(p) ? 'failed' : p.approval ? 'approved' : now >= Date.parse(p.expiresAt) ? 'stale' : 'waiting');

/** One plan as the CLI prints it: what it changes, who approves it, and where it came from. */
const brief = (p: PlanView, now: number) => ({
  id: p.id, state: stateOf(p, now), summary: p.summary?.words, level: p.summary?.level, approver: p.approver.who, why: p.approver.why,
  tool: p.tool, asset: `${p.asset.kind}/${p.asset.name}`, target: p.target, job: p.job, ...(p.issue ? { issue: p.issue } : {}),
  createdAt: p.createdAt, expiresAt: p.expiresAt, ...(p.approval ? { approvedBy: p.approval.by } : {}),
});

export function infraCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' } } });
  const [verb, id, ...extra] = positionals;
  if (verb === 'plans' && id === undefined) {
    return {
      role: 'viewer', path: '/api/infra-plans',
      pick: (v) => {
        const now = Date.now();
        return (v as { plans: PlanView[] }).plans.map((p) => brief(p, now)).filter((p) => values.all || p.state === 'waiting');
      },
    };
  }
  if (verb !== 'approve' || !id || extra.length > 0 || values.all) throw usage(LINE);
  const said = id.toLowerCase();
  return {
    role: 'admin', path: '/ui/api/infra-plans',
    body: async (get) => {
      const plans = ((await get('/api/infra-plans')) as { plans: PlanView[] }).plans.filter((p) => p.id.startsWith(said));
      if (plans.length === 0) throw new OperatorRefusal(`no infra plan ${id}: hopper infra plans --all lists them`);
      if (plans.length > 1) throw new OperatorRefusal(`${id} names ${plans.length} plans: give more of its id`);
      return { action: 'approve', plan: plans[0]!.id };
    },
    // A grant's API token is answered `{ waiting }` for a plan a person confirms (issue #909): printed as it is.
    pick: (v) => ((v as { plan?: PlanView }).plan ? brief((v as { plan: PlanView }).plan, Date.now()) : v),
  };
}
