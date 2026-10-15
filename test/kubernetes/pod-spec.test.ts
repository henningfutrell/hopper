// A job pod's manifest (issue #1283, design.md "Job pods on Kubernetes"): the pod runs the box image as its unprivileged
// user, dials out with its join line, and has nothing that listens — no sshd, no container port.
import { describe, expect, it } from 'vitest';
import { JOB_POD_UID, jobPod, jobPodName, labelValue } from '../../src/kubernetes/pod-spec.ts';

const base = {
  name: 'hopper-job-1b2c', jobId: '1b2c', instanceId: 'inst-1', image: 'ghcr.io/henningfutrell/hopper:box-claude',
  joinLine: 'http://hopper.hopper.svc:4790#' + 'a'.repeat(64), volume: { emptyDir: {} }, cpus: 2, memoryMb: 4096,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the manifest is loose JSON
const spec = (p: any) => p.spec;

describe('a job pod', () => {
  it('is named after its job: a DNS label and a machine name at once', () => {
    expect(jobPodName('0F8E3C2A-1111-4222-8333-444455556666')).toBe('hopper-job-0f8e3c2a-1111-4222-8333-444455556666');
    expect(() => jobPodName('../x')).toThrow(/no pod name/);
  });

  it('runs the box\'s entrypoint, with its join line and its name, and nothing that listens: no sshd, no port', () => {
    const p = jobPod(base);
    const [c] = spec(p).containers;
    expect(spec(p).containers).toHaveLength(1);
    expect(c.command).toEqual(['/usr/local/bin/hopper-box']);
    expect(c.env).toEqual(expect.arrayContaining([{ name: 'HOPPER_JOIN', value: base.joinLine }, { name: 'HOPPER_CLIENT_NAME', value: 'hopper-job-1b2c' }]));
    expect(c.ports).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/sshd|containerPort|hostPort|hostNetwork/);
    expect(spec(p).restartPolicy).toBe('Never');
  });

  it('runs as the credential-free job user: not root, no service account token, no capability, a read-only root', () => {
    const p = jobPod(base);
    expect(spec(p).automountServiceAccountToken).toBe(false);
    expect(spec(p).securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: JOB_POD_UID });
    for (const c of [...spec(p).initContainers, ...spec(p).containers]) {
      expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] } });
    }
  });

  it('keeps its home, where its work trees live, on an emptyDir, or on a directory of its own on a claim', () => {
    const empty = jobPod({ ...base, volume: { emptyDir: { sizeLimitGiB: 20 } } });
    expect(spec(empty).volumes[0]).toEqual({ name: 'home', emptyDir: { sizeLimit: '20Gi' } });
    expect(spec(empty).containers[0].volumeMounts[0]).toEqual({ name: 'home', mountPath: '/home/agent' });
    const claim = jobPod({ ...base, volume: { claim: 'hopper-jobs' } });
    expect(spec(claim).volumes[0]).toEqual({ name: 'home', persistentVolumeClaim: { claimName: 'hopper-jobs' } });
    expect(spec(claim).containers[0].volumeMounts[0]).toEqual({ name: 'home', mountPath: '/home/agent', subPath: 'hopper-job-1b2c' });
    // The image's seeded home is copied onto the volume first.
    expect(spec(claim).initContainers[0].volumeMounts[0]).toEqual({ name: 'home', mountPath: '/mnt/home', subPath: 'hopper-job-1b2c' });
  });

  it('carries the instance and job labels, and its CPU and memory as requests and limits', () => {
    const p = jobPod({ ...base, instanceId: 'Inst 1/x' });
    expect((p as { metadata: { labels: Record<string, string> } }).metadata.labels).toMatchObject({ 'io.hopper/instance': 'Inst-1-x', 'io.hopper/job': '1b2c' });
    expect(spec(p).containers[0].resources).toEqual({ requests: { cpu: '2', memory: '4096Mi' }, limits: { cpu: '2', memory: '4096Mi' } });
    expect(labelValue('--')).toBe('none');
  });
});
