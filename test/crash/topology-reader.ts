// What a crash host's topology reader answers (issue #1954, test/crash/topology-world.ts): the reader is the one seam of
// topology discovery that is not an outside service on loopback (STS and the Kubernetes API are fakes in the test
// process), so each host has its own, with the same answers. One account in one region, its cluster `prod`.
import type { TopologyReader } from '../../src/domain/ports.ts';
import { aws, kube } from '../support/topology-answers.ts';

export const crashTopologyReader: TopologyReader = {
  awsRegions: async () => [aws.region],
  aws: async (r) => ({ ...aws, account: r.account, region: r.region }),
  kube: async (r) => ({ ...kube, cluster: r.cluster }),
};
