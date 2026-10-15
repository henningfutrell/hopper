// The lane pool (design.md "Lane pods", issue #1284): long-lived lane pods — a Kubernetes StatefulSet's — that join the
// hopper by dialling out, each a client target under its pod's name. They join with the **lane pool key**, a preshared
// key the install makes and gives both the hopper (HOPPER_LANE_POOL_KEY, or the file HOPPER_LANE_POOL_KEY_FILE names)
// and the pods' join step. Unlike a join code it is not spent: every pod, and every restart of one, joins with it.
// It has a join code's shape (64 hex: `openssl rand -hex 32`), so the join line is the same `<hopper URL>#<key>`.
// The pods are the machines of the hopper's first user, `admin`: the person who signed in first.
import { createHash, timingSafeEqual } from 'node:crypto';

export const LANE_POOL_KEY_VARIABLE = 'HOPPER_LANE_POOL_KEY';

/** The user whose machines the lane pods are: the hopper's first user. */
export const LANE_POOL_USER = 'admin';

const KEY = /^[0-9a-f]{64}$/;
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Whether `code` is the lane pool key. False when the hopper has none, or none of the right shape. Constant time. */
export function isLanePoolKey(poolKey: string | undefined, code: string): boolean {
  return poolKey !== undefined && KEY.test(poolKey) && timingSafeEqual(digest(poolKey), digest(code));
}
