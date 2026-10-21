// Issue #708, part 9: the template request on Vault. A person writes what the box must do — its needs — and the hopper
// shows the template it would make from them before it makes it: its name, its image, the tools its needs use, that it
// holds no vault secret, and who approves it (the read policy, or a person, and why). The same derivation as a job's
// request (issue #716, design.md "Templates on request"); nothing is saved. Pure.
import { describe, expect, it } from 'vitest';
import type { TemplateView } from '../../src/domain/vault.ts';
import { needsOf, previewTemplate, requestedName } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const user = (o: { policy?: string[]; templates?: TemplateView[] } = {}) => ({
  template: (name: string) => o.templates?.find((t) => t.name === name),
  templates: () => o.templates ?? [],
  policy: () => (o.policy ? { assets: o.policy } : undefined),
  image: IMAGE,
});

describe('the template a request makes, shown before it is made (issue #708)', () => {
  it('shows the name, the image, the tools the needs use and no secret; read needs inside the policy are approved by it', () => {
    const p = previewTemplate(user({ policy: ['cluster/lab', 'aws-role/*'] }), { needs: 'read/cluster/lab read/aws-role/123456789012/ReadOnly' });
    expect(p).toEqual({
      template: requestedName(needsOf('read/cluster/lab read/aws-role/123456789012/ReadOnly') as never),
      image: IMAGE,
      tools: ['aws', 'helm', 'kubectl'],
      needs: ['read on cluster lab', 'read on aws-role 123456789012/ReadOnly'],
      readOnly: true,
      approvedBy: 'the read policy',
      waits: [],
    });
  });

  it('a write, or a read the policy does not hold, makes the whole template wait for a person, and says why', () => {
    const p = previewTemplate(user({ policy: ['cluster/lab'] }), { needs: 'read/cluster/lab read/cluster/prod write/namespace/lab/web' });
    expect(p).toMatchObject({
      readOnly: false,
      approvedBy: 'a person',
      waits: ['the read policy does not hold read on cluster prod', 'write on namespace lab/web changes the asset'],
    });
  });

  it('an observe changes no asset: a template of read and observe needs takes the read-only check (issue #2146, part 5)', () => {
    expect(previewTemplate(user(), { needs: 'observe/namespace/uat/monitoring read/cluster/uat' })).toMatchObject({ readOnly: true });
    expect(previewTemplate(user(), { needs: 'observe/namespace/uat/monitoring write/namespace/uat/web' })).toMatchObject({ readOnly: false });
  });

  it('with no read policy and low auto-approve off, every template waits for a person', () => {
    const off = { ...user(), approvals: () => ({ skipTemplateApproval: false, skipSandboxApproval: false, autoApprove: { low: false, medium: false, high: false } }) };
    expect(previewTemplate(off, { needs: 'read/cluster/lab' })).toMatchObject({ approvedBy: 'a person', waits: ['the read policy does not hold read on cluster lab'] });
  });

  it('says when the template is there already, and when a person changed it since', () => {
    const name = requestedName(needsOf('read/cluster/lab') as never);
    const waiting = { secrets: [], pending: { secrets: [], image: true, egress: [], profiles: [] } };
    const same = { name, ...waiting, profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] } as unknown as TemplateView;
    const changed = { name, ...waiting, profiles: [{ operation: 'write', asset: { kind: 'cluster', name: 'lab' } }] } as unknown as TemplateView;
    expect(previewTemplate(user({ templates: [same] }), { needs: 'read/cluster/lab' })).toMatchObject({ exists: 'same' });
    expect(previewTemplate(user({ templates: [changed] }), { needs: 'read/cluster/lab' })).toMatchObject({ exists: 'changed' });
    expect(previewTemplate(user(), { needs: 'read/cluster/lab' })).not.toHaveProperty('exists');
  });

  it('refuses needs it cannot read, with how to write it', () => {
    expect(previewTemplate(user(), { needs: '' })).toMatch(/^name what the work needs/);
    expect(previewTemplate(user(), { needs: 'delete/cluster/lab' })).toContain('the operation is one of');
  });
});
