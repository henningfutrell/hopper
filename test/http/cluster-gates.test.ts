// Issue #1289: a cluster install has no compose tunnel services and no Windows host. Remote access's status names no
// compose command there, and the Windows link report is refused, since no keep-alive loop on Windows runs beside a pod.
import { describe, expect, it } from 'vitest';
import { OperatorRefusal } from '../../src/cli-operator-call.ts';
import { windowsLinkCall } from '../../src/cli-operator-windows-link.ts';
import { tunnelServiceProblem } from '../../src/http/remote-access.ts';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const POD = { KUBERNETES_SERVICE_HOST: '10.96.0.1' };

describe('remote access, when no tunnel service asks', () => {
  it('on a host: the compose stack runs the tunnel services, and the status says how to start them', () => {
    expect(tunnelServiceProblem({ service: 'tunnel', cluster: false, keyed: false, at: undefined, now: NOW })).toMatch(/compose stack/);
    expect(tunnelServiceProblem({ service: 'cloudflared', cluster: false, keyed: true, at: undefined, now: NOW })).toMatch(/podman compose up -d/);
    expect(tunnelServiceProblem({ service: 'tunnel', cluster: false, keyed: true, at: new Date(NOW.getTime() - 5_000), now: NOW })).toBeUndefined();
  });

  it('in a cluster: no compose command, no Podman', () => {
    for (const keyed of [false, true]) {
      const problem = tunnelServiceProblem({ service: 'tunnel', cluster: true, keyed, at: undefined, now: NOW });
      expect(problem).toMatch(/cluster/);
      expect(problem).not.toMatch(/compose|podman/i);
    }
  });
});

describe('the Windows link report', () => {
  const args = ['report', '--link', 'http://localhost:4790/job/address', '--status', '204'];
  it('on a host it is made', () => {
    expect(windowsLinkCall(args, {}).path).toBe('/ui/api/windows-link');
  });
  it('in a cluster it is refused: no Windows host runs beside a pod', () => {
    expect(() => windowsLinkCall(args, POD)).toThrow(OperatorRefusal);
    expect(() => windowsLinkCall(args, POD)).toThrow(/Kubernetes/);
  });
});
