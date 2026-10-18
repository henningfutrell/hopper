// A topology in two AWS regions (issue #1893), for the globe's tests: the test account and cluster in eu-west-1
// (topology-answers.ts), a second region, us-east-1, with the database the cluster's deployment names (so a link joins
// the two regions), a bucket in us-east-1, a bucket S3 names no region for, and one in a region the globe does not know.
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology, kubeTopology } from '../../src/domain/topology-discover.ts';
import { aws, CLUSTER, kube } from './topology-answers.ts';

const AT = '2026-10-17T10:00:00.000Z';
export const EAST_DB = 'arn:aws:rds:us-east-1:111111111111:db:reports';

export const twoRegions = () => joinGraph([
  afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology({
    ...aws, buckets: [{ Name: 'east-logs', BucketRegion: 'us-east-1' }, { Name: 'old-files' }, { Name: 'moon-files', BucketRegion: 'eu-moon-9' }],
  }) }, 'collector', AT),
  afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'us-east-1' }, ok: true, ...awsTopology({
    account: '111111111111', region: 'us-east-1',
    databases: [{ DBInstanceArn: EAST_DB, DBInstanceIdentifier: 'reports', Engine: 'postgres', Endpoint: { Address: 'other.us-east-1.amazonaws.com', Port: 5432 } }],
  }) }, 'collector', AT),
  afterReport(undefined, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: true, ...kubeTopology(kube) }, 'collector', AT),
]);
