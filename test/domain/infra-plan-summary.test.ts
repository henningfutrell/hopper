// Issue #870: every plan gets a summary and an explainer in plain words — what it adds, changes, replaces and destroys,
// where; its risk callouts (destroys, IAM, prod, data, network); its blast radius — and a new AWS resource without the
// MAP tag fails the plan (design.md "Infra plans: the summary and the MAP tag check").
//
// Feature: a plan in plain words
//   Scenario: a terraform plan (terraform show -json) is read into its changes; reads and no-ops are not changes
//   Scenario: a helm diff and an Argo CD diff are read into their changes
//   Scenario: the summary says what changes where, and that nothing in prod changes and nothing is destroyed
//   Scenario: destroys, IAM, prod, data and network are called out, with the resources; any but network makes it high
//   Scenario: a new AWS resource without map-migrated fails the plan; an existing one, or a resource with no tags, does not
//   Scenario: a plan the hopper cannot read is refused, or, for a diff with no change it knows, said so and rated high
import { describe, expect, it } from 'vitest';
import { changesOf, MAP_TAG } from '../../src/domain/infra-plan-changes.ts';
import { summarize } from '../../src/domain/infra-plan-summary.ts';

const AWS = 'registry.terraform.io/hashicorp/aws';
const TAGS = { tags: {}, tags_all: { [MAP_TAG.key]: MAP_TAG.value } };
const rc = (address: string, actions: string[], after: Record<string, unknown> | null = TAGS, extra: Record<string, unknown> = {}) => ({
  address, mode: 'managed', type: address.split('.')[0], provider_name: AWS, change: { actions, before: null, after, after_unknown: {} }, ...extra,
});
const tf = (...changes: unknown[]) => JSON.stringify({ format_version: '1.2', planned_values: {}, resource_changes: changes });
const at = { target: 'uat-network', asset: { kind: 'aws-role' as const, name: '123456789012/deploy' } };

describe('the changes of a plan', () => {
  it('reads a terraform plan: create, update, replace, delete; skips reads, no-ops and data sources', () => {
    const changes = changesOf('terraform', '', tf(
      rc('aws_security_group_rule.a', ['create']), rc('aws_instance.web', ['update']), rc('aws_db_instance.main', ['delete', 'create']),
      rc('aws_s3_bucket.logs', ['delete'], null), rc('aws_vpc.main', ['no-op']), rc('data.aws_caller_identity.me', ['read'], null, { mode: 'data' }),
    ));
    expect(changes).toEqual([
      expect.objectContaining({ address: 'aws_security_group_rule.a', type: 'aws_security_group_rule', action: 'create' }),
      expect.objectContaining({ address: 'aws_instance.web', action: 'update' }),
      expect.objectContaining({ address: 'aws_db_instance.main', action: 'replace' }),
      expect.objectContaining({ address: 'aws_s3_bucket.logs', action: 'delete' }),
    ]);
  });

  it('refuses a terraform plan with no JSON, or JSON that is not a plan', () => {
    expect(changesOf('terraform', 'Plan: 1 to add', undefined)).toMatch(/^json must hold terraform show -json/);
    expect(changesOf('terraform', '', '{nope')).toMatch(/^json is not JSON/);
    expect(changesOf('terraform', '', '{"format_version":"1.2"}')).toMatch(/resource_changes/);
    expect(changesOf('helm', 'x', '{}')).toMatch(/^json is for a terraform plan only/);
  });

  it('reads a helm diff and an Argo CD diff', () => {
    const helm = ['default, web, Deployment (apps) has changed:', '-  replicas: 2', '+  replicas: 3',
      'default, web-sa, ServiceAccount (v1) has been added:', 'default, old, ConfigMap (v1) has been removed:'].join('\n');
    expect(changesOf('helm', helm, undefined)).toEqual([
      { address: 'default/Deployment/web', type: 'Deployment', action: 'update' },
      { address: 'default/ServiceAccount/web-sa', type: 'ServiceAccount', action: 'create' },
      { address: 'default/ConfigMap/old', type: 'ConfigMap', action: 'delete' },
    ]);
    const argo = ['===== apps/Deployment prod/web ======', '12c12', '<   replicas: 2', '---', '>   replicas: 3',
      '===== /Service prod/web ======', '>   port: 80', '===== networking.k8s.io/Ingress prod/old ======', '<   host: a'].join('\n');
    expect(changesOf('gitops', argo, undefined)).toEqual([
      { address: 'prod/Deployment/web', type: 'Deployment', action: 'update' },
      { address: 'prod/Service/web', type: 'Service', action: 'create' },
      { address: 'prod/Ingress/old', type: 'Ingress', action: 'delete' },
    ]);
  });
});

describe('the summary of a plan', () => {
  it('says what changes where; nothing in prod changes; nothing is destroyed; low risk', () => {
    const changes = changesOf('terraform', '', tf(rc('aws_security_group_rule.a', ['create']), rc('aws_security_group_rule.b', ['create'])));
    const s = summarize('terraform', changes as never, at);
    expect(s.words).toBe('Adds 2 security group rules in uat; changes nothing in prod; destroys nothing');
    expect(s.level).toBe('low');
    expect(s.counts).toEqual({ create: 2, update: 0, replace: 0, delete: 0 });
    expect(s.environments).toEqual(['uat']);
    expect(s.risks).toEqual([{ risk: 'network', words: 'Network: 2 resources: aws_security_group_rule.a, aws_security_group_rule.b', resources: ['aws_security_group_rule.a', 'aws_security_group_rule.b'] }]);
    expect(s.blastRadius).toBe('2 resources of 1 kind, in uat; applied as aws-role 123456789012/deploy to uat-network');
    expect(s.checks).toEqual([{ name: 'map-tag', ok: true, words: `Every new AWS resource has the MAP tag ${MAP_TAG.key}=${MAP_TAG.value}` }]);
    expect(s.failed).toBe(false);
  });

  it('calls out destroys, IAM, prod and data, with the resources, and rates the plan high', () => {
    const changes = changesOf('terraform', '', tf(
      rc('aws_iam_role_policy.deploy', ['update']), rc('aws_db_instance.main', ['delete', 'create']), rc('aws_instance.prod_web', ['update']),
    ));
    const s = summarize('terraform', changes as never, { ...at, target: 'uat-data' });
    expect(s.level).toBe('high');
    expect(s.risks.map((r) => r.risk)).toEqual(['destroy', 'iam', 'prod', 'data']);
    expect(s.risks[0]).toEqual({ risk: 'destroy', words: 'Destroys: 1 resource: aws_db_instance.main (replaced)', resources: ['aws_db_instance.main'] });
    expect(s.risks[2]!.resources).toEqual(['aws_instance.prod_web']);
    expect(s.words).toBe('Changes 1 iam role policy, 1 instance, replaces 1 db instance in uat, prod');
  });

  it('a new AWS resource without the MAP tag fails the plan; an existing one, and one with no tags, do not', () => {
    const changes = changesOf('terraform', '', tf(
      rc('aws_instance.new', ['create'], { tags: { Name: 'x' }, tags_all: { Name: 'x' } }),
      rc('aws_instance.old', ['update'], { tags: {}, tags_all: {} }),
      rc('aws_instance.replaced', ['create', 'delete'], { tags: {}, tags_all: {} }),
      rc('aws_security_group_rule.r', ['create'], { from_port: 443 }),
      rc('aws_s3_bucket.ok', ['create'], { tags: { [MAP_TAG.key]: MAP_TAG.value }, tags_all: {} }),
    ));
    const s = summarize('terraform', changes as never, at);
    expect(s.checks).toEqual([{ name: 'map-tag', ok: false, words: `1 new AWS resource lacks the MAP tag ${MAP_TAG.key}=${MAP_TAG.value}: aws_instance.new`, resources: ['aws_instance.new'] }]);
    expect(s.failed).toBe(true);
    expect(s.level).toBe('high');
    // Not an AWS resource: no MAP tag asked.
    const other = changesOf('terraform', '', tf({ ...rc('google_compute_instance.a', ['create'], { labels: {} }), provider_name: 'registry.terraform.io/hashicorp/google' }));
    expect(summarize('terraform', other as never, at).failed).toBe(false);
  });

  it('a plan that changes nothing says so; a diff with no change the hopper knows is said so, and rated high', () => {
    expect(summarize('terraform', [], at)).toMatchObject({ words: 'Changes nothing', level: 'low' });
    expect(summarize('helm', [], at)).toMatchObject({ words: 'The hopper found no change it knows in this diff: read the plan', level: 'high' });
  });

  it('says where it is when no environment is named', () => {
    const s = summarize('helm', changesOf('helm', 'web, web, Deployment (apps) has changed:', undefined) as never, { ...at, target: 'web' });
    expect(s.words).toBe('Changes 1 Deployment, environment not named; destroys nothing');
  });
});
