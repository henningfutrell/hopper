// A running job reads the infrastructure topology (issue #1905, design.md "The infrastructure topology"): its user's graph,
// as `GET /api/topology` answers it to a person, outside the UI session, on the hopper's own URL and behind the Host guard,
// like the job's plans (job-infra-plans.ts). A job starts from it as its map of accounts, VPCs, clusters and load balancers.
//
//   GET /job/topology     `Authorization: Bearer <the job's proxy token>`. The graph, as JSON.
//
// 401: the token is no job's, or its job is not at work. It changes nothing and records nothing.
import type { FastifyInstance } from 'fastify';
import type { JobStatus } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import type { Tenants } from './tenants.ts';

export const JOB_TOPOLOGY_PATH = '/job/topology';
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;

export function jobTopologyRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  app.get(JOB_TOPOLOGY_PATH, async (req, reply) => {
    const no = (text: string) => reply.code(401).type('text/plain; charset=utf-8').send(`no: ${text}\n`);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const t = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
    if (!t || !job) return no('the token is not a job\'s of this hopper. A job reads with its own HOPPER_TOKEN_FILE.');
    if (!AT_WORK.includes(job.status)) return no(`job ${job.id} is ${job.status}, not at work: only a job at work reads the topology.`);
    return reply.header('cache-control', 'no-store').send(t.githubProxy.topology.graph());
  });
}
