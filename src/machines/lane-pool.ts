// The lane pool (design.md "Lane pods", issue #1284): long-lived lane pods — a Kubernetes StatefulSet's — that join the
// hopper by dialling out, each a client target under its pod's name. They join with the **lane pool key**, a preshared
// key the install makes and gives both the hopper (HOPPER_LANE_POOL_KEY, or the file HOPPER_LANE_POOL_KEY_FILE names)
// and the pods' join step. Unlike a join code it is not spent: every pod, and every restart of one, joins with it.
// It has a join code's shape (64 hex: `openssl rand -hex 32`), so the join line is the same `<hopper URL>#<key>`.
// The pods are the machines of the hopper's first user, `admin`: the person who signed in first.
import { createHash, timingSafeEqual } from 'node:crypto';
import { AGENT_CREDENTIAL_VARIABLE, POD_AGENT_CREDENTIAL } from '../domain/agent-credential.ts';
import type { AttachedMachine } from '../domain/types.ts';
import type { AgentCredentialAnswer, PodCredentialAsk } from '../vault/agent-credential.ts';

export const LANE_POOL_KEY_VARIABLE = 'HOPPER_LANE_POOL_KEY';

/** The user whose machines the lane pods are: the hopper's first user. */
export const LANE_POOL_USER = 'admin';

const KEY = /^[0-9a-f]{64}$/;
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Whether `code` is the lane pool key. False when the hopper has none, or none of the right shape. Constant time. */
export function isLanePoolKey(poolKey: string | undefined, code: string): boolean {
  return poolKey !== undefined && KEY.test(poolKey) && timingSafeEqual(digest(poolKey), digest(code));
}

/** The agent's sign-in a lane pod gives: its variable and value, none, or why not. */
export type LaneSignIn = { variable: string; value: string } | { none: true } | { refused: string };

/**
 * The agent's sign-in on a lane pod (issue #1287, design.md "The agent's sign-in in a lane pod"): a job on a lane pod
 * starts with its user's setup token from the vault, as a job pod's does, so a pod started again — its volume kept or
 * not — asks for no sign-in, and none need be kept on its volume. A usage read of the pod (no job) takes the same token,
 * else it reads the pod signed out. Any other machine: none, its own sign-in as before.
 */
export function laneSignIn(
  targets: () => readonly AttachedMachine[],
  podCredential: (ask: PodCredentialAsk) => Promise<AgentCredentialAnswer>,
): (machine: string, job?: string) => Promise<LaneSignIn> {
  return async (machine, job) => {
    const lanePod = targets().some((t) => t.name === machine && 'client' in t && t.client.pool);
    if (!lanePod) return { none: true };
    const r = await podCredential({ name: POD_AGENT_CREDENTIAL, pod: machine, ...(job ? { job } : {}) });
    return 'value' in r ? { variable: AGENT_CREDENTIAL_VARIABLE, value: r.value } : r;
  };
}
