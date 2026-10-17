// Telemetry in the Helm chart (issue #1486, docs/deploy.md "Telemetry"): the hopper's OTEL_* variables as values or from
// a Secret, and an optional viewer in the release that the hopper exports to and that only the hopper reaches.
// Asserted on what `helm template` renders.
import { describe, expect, it } from 'vitest';
import { container, env, find, helm, pod, render } from '../support/helm-chart.ts';

const daemonOf = (sets: string[]) => container(find(render(...sets), 'Deployment', 'hopper'), 'hopper');

describe('the Helm chart\'s telemetry', () => {
  it('is off by default: no OTEL_* variable, no viewer', () => {
    const rs = render();
    expect((daemonOf([]).env ?? []).filter((e) => e.name.startsWith('OTEL_'))).toEqual([]);
    expect(rs.filter((r) => r.metadata.name === 'hopper-telemetry')).toEqual([]);
  });

  it('passes the OTEL_* values as they are, and refuses any other name', () => {
    const d = daemonOf(['telemetry.env.OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318', 'telemetry.env.OTEL_TRACES_SAMPLER=always_on']);
    expect(env(d, 'OTEL_EXPORTER_OTLP_ENDPOINT')?.value).toBe('http://collector:4318');
    expect(env(d, 'OTEL_TRACES_SAMPLER')?.value).toBe('always_on');
    const bad = helm(['template', 'hopper', '/chart', '--set', 'telemetry.env.HOPPER_MASTER_KEY=x']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('telemetry.env takes OTEL_* variables only');
  });

  it('reads the OTEL_* variables kept in a Secret, never as a value', () => {
    const d = daemonOf(['telemetry.envFromSecret=hopper-otel']) as ReturnType<typeof daemonOf> & { envFrom?: { secretRef?: { name: string } }[] };
    expect(d.envFrom).toEqual([{ secretRef: { name: 'hopper-otel' } }]);
  });

  it('with the viewer on, exports to it, and only the hopper reaches its OTLP port', () => {
    const rs = render('telemetry.viewer.enabled=true');
    const d = container(find(rs, 'Deployment', 'hopper'), 'hopper');
    expect(env(d, 'OTEL_EXPORTER_OTLP_ENDPOINT')?.value).toBe('http://hopper-telemetry:4318');
    expect(find(rs, 'Service', 'hopper-telemetry').spec?.ports?.map((p) => p.port).sort()).toEqual([3000, 4318]);
    const viewer = pod(find(rs, 'StatefulSet', 'hopper-telemetry'));
    expect(viewer.automountServiceAccountToken).toBe(false);
    expect(viewer.containers[0]?.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    const policy = find(rs, 'NetworkPolicy', 'hopper-telemetry').spec?.ingress ?? [];
    expect(policy.flatMap((i) => i.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'])).toEqual(['hopper']);
    // An endpoint named in the values wins over the viewer's.
    const own = daemonOf(['telemetry.viewer.enabled=true', 'telemetry.env.OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']);
    expect((own.env ?? []).filter((e) => e.name === 'OTEL_EXPORTER_OTLP_ENDPOINT').map((e) => e.value)).toEqual(['http://collector:4318']);
  });
});
