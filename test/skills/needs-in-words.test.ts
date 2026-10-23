// Issue #708: a person writes what the box must do in plain words ("kubectl get pods in namespace web on cluster lab"),
// and the hopper reads the needs from them. The reader is a fixed set of words, so the same words always give the same
// needs: it names the assets the words name, a read for each read word, and a change only where a word says one. Pure.
import { describe, expect, it } from 'vitest';
import { needsFromWords } from '../../src/skills/needs-in-words.ts';
import { needsOf, previewTemplate, requestedName } from '../../src/skills/template-request.ts';

const read = (kind: string, name: string) => ({ operation: 'read', asset: { kind, name } });

describe('needs read from plain words (issue #708)', () => {
  it('reads the assets the words name, with a read for read words', () => {
    expect(needsFromWords('kubectl get pods on cluster lab')).toEqual([read('cluster', 'lab')]);
    expect(needsFromWords('Run terraform plan on workspace net-prod.')).toEqual([read('terraform-workspace', 'net-prod')]);
    expect(needsFromWords('aws s3 ls in account 123456789012')).toEqual([read('aws-account', '123456789012')]);
    expect(needsFromWords('aws ec2 describe-instances in account 123456789012')).toEqual([read('aws-account', '123456789012')]);
    expect(needsFromWords('aws s3api delete-bucket in account 123456789012')).toEqual([{ operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } }]);
    expect(needsFromWords('show the Argo CD app billing')).toEqual([read('argocd-app', 'billing')]);
    expect(needsFromWords('list the pods of the cluster named lab and of the cluster called stage')).toEqual([read('cluster', 'lab'), read('cluster', 'stage')]);
  });

  it('puts a namespace in its cluster, and a role in its account', () => {
    expect(needsFromWords('read logs in namespace web on cluster lab')).toEqual([read('namespace', 'lab/web')]);
    expect(needsFromWords('describe namespace lab/web')).toEqual([read('namespace', 'lab/web')]);
    expect(needsFromWords('get the caller identity with role ReadOnly in account 123456789012')).toEqual([read('aws-role', '123456789012/ReadOnly')]);
  });

  it('names a change only where a word says one: apply, sync, or another change is write', () => {
    expect(needsFromWords('terraform apply on workspace net')).toEqual([{ operation: 'apply', asset: { kind: 'terraform-workspace', name: 'net' } }]);
    expect(needsFromWords('sync the argocd app billing')).toEqual([{ operation: 'sync', asset: { kind: 'argocd-app', name: 'billing' } }]);
    expect(needsFromWords('plan and apply workspace net')).toEqual([
      read('terraform-workspace', 'net'),
      { operation: 'apply', asset: { kind: 'terraform-workspace', name: 'net' } },
    ]);
    expect(needsFromWords('restart the deployments in namespace web on cluster lab')).toEqual([{ operation: 'write', asset: { kind: 'namespace', name: 'lab/web' } }]);
    expect(needsFromWords('helm upgrade on cluster lab')).toEqual([{ operation: 'write', asset: { kind: 'cluster', name: 'lab' } }]);
  });

  it('names an observe for a port-forward (issue #2146), and no change', () => {
    expect(needsFromWords('kubectl port-forward to prometheus in namespace metrics on cluster utility')).toEqual([{ operation: 'observe', asset: { kind: 'namespace', name: 'utility/metrics' } }]);
    expect(needsFromWords('observe and query the cluster utility')).toEqual([read('cluster', 'utility'), { operation: 'observe', asset: { kind: 'cluster', name: 'utility' } }]);
  });

  it('a change word after not or never makes no change need', () => {
    expect(needsFromWords('get pods on cluster lab, never delete them')).toEqual([read('cluster', 'lab')]);
    expect(needsFromWords('watch the cluster lab but do not restart anything')).toEqual([read('cluster', 'lab')]);
  });

  it('refuses words it cannot read, and says what to write', () => {
    expect(needsFromWords('look at the pods')).toMatch(/names no asset/);
    expect(needsFromWords('get pods on the cluster')).toMatch(/cluster: say its name/);
    expect(needsFromWords('do things on cluster lab')).toMatch(/say what the box does on cluster lab/);
    expect(needsFromWords('read namespace web')).toMatch(/namespace web: say its cluster/);
    expect(needsFromWords('read namespace web on cluster lab and cluster stage')).toMatch(/namespace web: say its cluster/);
    expect(needsFromWords('read role ReadOnly')).toMatch(/role ReadOnly: say its account/);
    expect(needsFromWords('read cluster la$b')).toMatch(/cluster la\$b: an asset name/);
  });
});

describe('a template request takes needs in words, or written as needs, or both (issue #708)', () => {
  it('a line of words and a line of needs make one template, the same as the needs written out', () => {
    const words = needsOf('kubectl get pods on cluster lab\nread/aws-account/123456789012');
    expect(words).toEqual([read('cluster', 'lab'), read('aws-account', '123456789012')]);
    expect(requestedName(words as never)).toBe(requestedName(needsOf('read/cluster/lab read/aws-account/123456789012') as never));
  });

  it('a need written out keeps its own refusals', () => {
    expect(needsOf('delete/cluster/lab')).toContain('the operation is one of read, write, sync, apply');
    expect(needsOf('read/cluster/la b')).toContain('write each need as <operation>/<kind>/<asset>');
  });

  it('the preview shows the needs the words make, and a change in words waits for a person', () => {
    const user = { template: () => undefined, templates: () => [], policy: () => ({ assets: ['cluster/lab'] }), image: 'box' };
    expect(previewTemplate(user, { needs: 'kubectl get pods on cluster lab' })).toMatchObject({ needs: ['read on cluster lab'], approvedBy: 'the read policy', readOnly: true });
    expect(previewTemplate(user, { needs: 'delete stuck pods on cluster lab' })).toMatchObject({ needs: ['write on cluster lab'], approvedBy: 'a person', readOnly: false });
  });
});
