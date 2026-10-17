import { describe, expect, it } from 'vitest';
import { container, env, find, helm, pod, render } from '../support/helm-chart.ts';

// A runner-only release (issue #1454, docs/deploy.md "Lane pods of another release"): hopper.enabled=false renders the
// lane pods alone, which join a hopper outside the release — a compose hopper — at lanes.hopperUrl, with the key that
// hopper issued, in lanes.existingSecret. No hopper, no Postgres, no host path, no host credential.
const RUNNER = ['hopper.enabled=false', 'lanes.replicas=1', 'lanes.hopperUrl=https://hopper.example.com', 'lanes.existingSecret=runner-pool-key'];

describe('the Helm chart, runner-only', () => {
  const rs = render(...RUNNER);
  const lanes = find(rs, 'StatefulSet', 'hopper-lanes');
  const join = pod(lanes).initContainers!.find((c) => c.name === 'join')!;

  it('renders the lane pods and their NetworkPolicy alone: no hopper, no database, no Secret of its own', () => {
    expect(rs.map((r) => `${r.kind}/${r.metadata.name}`).sort()).toEqual(['NetworkPolicy/hopper-lanes', 'StatefulSet/hopper-lanes']);
  });

  it('joins the hopper lanes.hopperUrl names, with the key in lanes.existingSecret', () => {
    expect(env(join, 'HOPPER_URL')?.value).toBe('https://hopper.example.com');
    expect(pod(lanes).volumes?.find((v) => v.name === 'lane-pool')?.secret?.secretName).toBe('runner-pool-key');
    expect(join.command?.join(' ')).toContain('join "$HOPPER_URL#$(cat /run/lane-pool/key)" "$POD_NAME"');
  });

  it('mounts no host path and gives the jobs\' container no credential', () => {
    expect((pod(lanes).volumes ?? []).filter((v) => 'hostPath' in v)).toEqual([]);
    const lane = container(lanes, 'lane');
    expect((lane.volumeMounts ?? []).map((m) => m.name).sort()).toEqual(['home', 'tmp']);
    for (const e of lane.env ?? []) expect(e.name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/);
  });

  it('refuses a runner-only release with no hopper URL or no Secret, or a URL with a path', () => {
    const out = (...set: string[]) => helm(['template', 'hopper', '/chart', ...set.flatMap((s) => ['--set', s])]);
    expect(out('hopper.enabled=false', 'lanes.existingSecret=k').stderr).toMatch(/needs lanes\.hopperUrl/);
    expect(out('hopper.enabled=false', 'lanes.hopperUrl=http://box.lan:4790').stderr).toMatch(/needs lanes\.existingSecret/);
    expect(out(...RUNNER.slice(0, 2), 'lanes.hopperUrl=http://box.lan:4790/ui', 'lanes.existingSecret=k').stderr).toMatch(/no path/);
  });

  it('with the hopper on, an existing Secret is the key both the hopper and the pods read, and the chart makes none', () => {
    const both = render('lanes.replicas=1', 'lanes.existingSecret=given-key');
    expect(both.some((r) => r.kind === 'Secret' && r.metadata.name === 'hopper-lane-pool')).toBe(false);
    const hopper = find(both, 'Deployment', 'hopper');
    expect(pod(hopper).volumes?.find((v) => v.name === 'lane-pool')?.secret?.secretName).toBe('given-key');
    expect(env(pod(find(both, 'StatefulSet', 'hopper-lanes')).initContainers![0]!, 'HOPPER_URL')?.value).toBe('http://hopper:4790');
  });
});
