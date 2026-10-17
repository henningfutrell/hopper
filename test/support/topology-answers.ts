// What a test AWS account and a test Kubernetes cluster answer a read-only check (issue #1781): an EKS cluster in a VPC,
// a load balancer in front of a service, a database and a queue a workload names, a service account with an IAM role of
// another account (IRSA), and a role another account may assume. As the AWS CLI and kubectl print them.
import type { AwsAnswers, KubeAnswers } from '../../src/domain/topology-discover.ts';

export const CLUSTER = 'arn:aws:eks:eu-west-1:111111111111:cluster/prod';
export const ROLE = 'arn:aws:iam::222222222222:role/orders-irsa';
const LB_HOST = 'k8s-web-1234.elb.eu-west-1.amazonaws.com';
export const DB_HOST = 'orders.abc123.eu-west-1.rds.amazonaws.com';
export const QUEUE = 'https://sqs.eu-west-1.amazonaws.com/111111111111/orders';

export const aws: AwsAnswers = {
  account: '111111111111', region: 'eu-west-1',
  vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', Tags: [{ Key: 'Name', Value: 'prod-vpc' }] }],
  clusters: [{ name: 'prod', arn: CLUSTER, version: '1.31', resourcesVpcConfig: { vpcId: 'vpc-1' } }],
  loadBalancers: [{ LoadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/net/k8s-web/1234', LoadBalancerName: 'k8s-web', DNSName: LB_HOST, VpcId: 'vpc-1', Type: 'network' }],
  databases: [{ DBInstanceArn: 'arn:aws:rds:eu-west-1:111111111111:db:orders', DBInstanceIdentifier: 'orders', Engine: 'postgres', Endpoint: { Address: DB_HOST, Port: 5432 }, DBSubnetGroup: { VpcId: 'vpc-1' } }],
  queues: [QUEUE],
  roles: [{
    Arn: 'arn:aws:iam::111111111111:role/deploy', RoleName: 'deploy',
    AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::333333333333:root' } }] })),
  }],
};

export const kube: KubeAnswers = {
  cluster: CLUSTER, name: 'prod',
  namespaces: [{ metadata: { name: 'shop' } }],
  deployments: [{
    metadata: { name: 'orders', namespace: 'shop' },
    spec: { replicas: 2, template: { metadata: { labels: { app: 'orders' } }, spec: {
      serviceAccountName: 'orders', containers: [{ env: [{ name: 'DB', value: `postgres://${DB_HOST}:5432/orders` }, { name: 'Q', value: QUEUE }, { name: 'X', value: 'other.us-east-1.amazonaws.com' }] }],
    } } },
  }],
  services: [{ metadata: { name: 'orders', namespace: 'shop' }, spec: { type: 'LoadBalancer', selector: { app: 'orders' } }, status: { loadBalancer: { ingress: [{ hostname: LB_HOST }] } } }],
  ingresses: [{ metadata: { name: 'web', namespace: 'shop' }, spec: { rules: [{ http: { paths: [{ backend: { service: { name: 'orders' } } }] } }] } }],
  serviceAccounts: [{ metadata: { name: 'orders', namespace: 'shop', annotations: { 'eks.amazonaws.com/role-arn': ROLE } } }],
};
