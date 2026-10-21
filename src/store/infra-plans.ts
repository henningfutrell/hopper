// Infra plans (issue #870, tenant migration 46): one row each, never updated — what the job said and when, as JSON, its
// text and its saved plan file in columns of their own, so a list reads neither. A person's approval is a row of its
// own table, so approving a plan changes no plan. A person's rejection (issue #2368, tenant migration 91) too. The file
// crosses the store's text-only parameters as base64.
import type { InfraPlan, InfraPlanRepository, KeptPlanView, PlanApproval, PlanRejection } from '../domain/infra-plans.ts';
import { parse, type StoreContext } from './context.ts';

export const INFRA_PLAN_TABLES = `
  CREATE TABLE infra_plans (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, body TEXT NOT NULL, text TEXT NOT NULL, file BYTEA);
  CREATE TABLE infra_plan_approvals (plan_id TEXT PRIMARY KEY REFERENCES infra_plans (id), body TEXT NOT NULL)`;
export const INFRA_PLAN_REJECTION_TABLE = 'CREATE TABLE infra_plan_rejections (plan_id TEXT PRIMARY KEY REFERENCES infra_plans (id), body TEXT NOT NULL)';

export function createInfraPlanRepository(c: StoreContext): InfraPlanRepository {
  const approval = (id: string): PlanApproval | undefined => {
    const r = c.db.get('SELECT body FROM infra_plan_approvals WHERE plan_id = ?', id);
    return r ? parse<PlanApproval>(r.body) : undefined;
  };
  const rejection = (id: string): PlanRejection | undefined => {
    const r = c.db.get('SELECT body FROM infra_plan_rejections WHERE plan_id = ?', id);
    return r ? parse<PlanRejection>(r.body) : undefined;
  };
  return {
    add(plan, file) {
      const { text, ...body } = plan;
      c.db.run(`INSERT INTO infra_plans (id, created_at, body, text, file) VALUES (?, ?, ?, ?, ${file ? "decode(?, 'base64')" : '?'})`,
        plan.id, plan.createdAt, JSON.stringify(body), text, file ? file.toString('base64') : null);
    },
    get(id) {
      const r = c.db.get('SELECT body, text FROM infra_plans WHERE id = ?', id);
      return r ? { ...parse<Omit<InfraPlan, 'text'>>(r.body), text: r.text as string } : undefined;
    },
    file(id) {
      const r = c.db.get("SELECT encode(file, 'base64') AS file FROM infra_plans WHERE id = ? AND file IS NOT NULL", id);
      return r ? Buffer.from(r.file as string, 'base64') : undefined;
    },
    list: (limit) => c.db.all(`SELECT p.body, a.body AS approval, j.body AS rejection FROM infra_plans p LEFT JOIN infra_plan_approvals a ON a.plan_id = p.id
      LEFT JOIN infra_plan_rejections j ON j.plan_id = p.id ORDER BY p.created_at DESC, p.seq DESC LIMIT ?`, limit).map((r): KeptPlanView => ({
      ...parse<KeptPlanView>(r.body), ...(r.approval !== null ? { approval: parse<PlanApproval>(r.approval) } : {}),
      ...(r.rejection !== null ? { rejection: parse<PlanRejection>(r.rejection) } : {}),
    })),
    approve(a) {
      c.db.run('INSERT INTO infra_plan_approvals (plan_id, body) VALUES (?, ?)', a.plan, JSON.stringify(a));
    },
    approval,
    reject(r) {
      c.db.run('INSERT INTO infra_plan_rejections (plan_id, body) VALUES (?, ?)', r.plan, JSON.stringify(r));
    },
    rejection,
  };
}
