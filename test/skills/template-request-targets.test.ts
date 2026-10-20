// Issue #2146 (the bastion path, part 3): a template request that names bastion targets. `sandbox-template --needs
// "observe/namespace/uat/monitoring" --targets "uat/monitoring/svc/grafana:80"` saves a template that names the targets,
// under a name of its own; each target needs an observe of the request on its namespace or cluster. The targets are
// approved with the template, as its observe is: by a person.
import { describe, expect, it } from 'vitest';
import type { TemplateView } from '../../src/domain/vault.ts';
import { askOf, extrasOf } from '../../src/skills/template-ask.ts';
import { requestedName, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const GRAFANA = 'uat/monitoring/svc/grafana:80';
const ASK = { needs: 'observe/namespace/uat/monitoring', targets: `${GRAFANA} uat/monitoring/svc/prometheus-server:9090` };

function user() {
  const templates = new Map<string, TemplateView>();
  const saved: Parameters<TemplateRequestUser['save']>[0][] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      saved.push(t);
      templates.set(t.name, { ...t, pending: { secrets: [], image: true, egress: [], profiles: [...t.profiles], bastionTargets: [...(t.bastionTargets ?? [])] }, gives: [], radius: { level: 'high', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    async approve(name, by) {
      const t = templates.get(name)!;
      templates.set(name, { ...t, approval: { by } as never, pending: { secrets: [], image: false, egress: [], profiles: [], bastionTargets: [] } });
      return { ok: true };
    },
    async approveProfile() { return { ok: true }; },
    policy: () => undefined,
    approvals: () => ({ skipTemplateApproval: false, skipSandboxApproval: false }),
    image: IMAGE,
  };
  return { u, saved, templates };
}

describe('a template request with bastion targets (issue #2146, part 3)', () => {
  it('saves the targets with the observe, under a name of its own, and waits for a person', async () => {
    const { u, saved } = user();
    const r = await requestTemplate(u, ASK, 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect(saved).toEqual([expect.objectContaining({
      bastionTargets: [GRAFANA, 'uat/monitoring/svc/prometheus-server:9090'], profiles: [{ operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } }],
    })]);
    expect(saved[0]!.name).not.toBe(requestedName([{ operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } }]));
  });

  it('uses the template it made again for the same targets, in any order; other targets name another', async () => {
    const { u, templates } = user();
    const first = await requestTemplate(u, ASK, 'job j1', 'j1');
    const name = 'template' in first ? first.template : '';
    await u.approve(name, 'a person');
    const again = await requestTemplate(u, { ...ASK, targets: `uat/monitoring/svc/prometheus-server:9090 ${GRAFANA}` }, 'job j2', 'j2');
    expect(again).toMatchObject({ status: 200, template: name });
    expect('text' in again && again.text).toContain(`bastion target ${GRAFANA}`);
    await requestTemplate(u, { ...ASK, targets: GRAFANA }, 'job j3', 'j3');
    expect(templates.size).toBe(2);
  });

  it('refuses a target no observe of the request reaches, and a target that is not one', async () => {
    const { u } = user();
    const r = await requestTemplate(u, { ...ASK, targets: 'prod/monitoring/svc/grafana:80' }, 'job j1', 'j1');
    expect(r.status).toBe(400);
    expect('reason' in r && r.reason).toContain('observe/namespace/prod/monitoring');
    expect(extrasOf({ targets: 'uat/monitoring/grafana:80' })).toMatch(/a target is <cluster>\/<namespace>/);
  });

  it('reads the targets sorted, each once, from a skill request body', () => {
    expect(extrasOf({ targets: `uat/monitoring/svc/prometheus-server:9090 ${GRAFANA} ${GRAFANA}` })).toEqual({ secrets: [], egress: [], targets: [GRAFANA, 'uat/monitoring/svc/prometheus-server:9090'] });
    const body: Record<string, string> = { needs: 'observe/namespace/uat/monitoring', targets: GRAFANA };
    expect(askOf((k) => body[k])).toEqual(body);
  });
});
