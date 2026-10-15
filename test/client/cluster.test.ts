// Issue #1289: a process knows it runs in a Kubernetes pod by KUBERNETES_SERVICE_HOST, and reads its pod's limits from
// the Downward API variables the chart sets: HOPPER_POD_CPU_LIMIT in millicores, HOPPER_POD_MEMORY_LIMIT in bytes.
import { describe, expect, it } from 'vitest';
import { inCluster, podLimits } from '../../src/client/cluster.ts';

describe('in a Kubernetes pod', () => {
  it('is found by KUBERNETES_SERVICE_HOST, and only by it', () => {
    expect(inCluster({ KUBERNETES_SERVICE_HOST: '10.96.0.1' })).toBe(true);
    expect(inCluster({ KUBERNETES_SERVICE_HOST: '' })).toBe(false);
    expect(inCluster({})).toBe(false);
  });

  it('reads the pod\'s limits: millicores as cores, bytes as bytes; a value that is not a positive whole number is none', () => {
    expect(podLimits({ HOPPER_POD_CPU_LIMIT: '1500', HOPPER_POD_MEMORY_LIMIT: '2147483648' })).toEqual({ cores: 1.5, memBytes: 2147483648 });
    expect(podLimits({ HOPPER_POD_CPU_LIMIT: '0', HOPPER_POD_MEMORY_LIMIT: '2Gi' })).toEqual({});
    expect(podLimits({})).toEqual({});
  });
});
