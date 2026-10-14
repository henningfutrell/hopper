// A terraform workspace's state backend (issue #715, part 6; design.md "A read-only infra box"): the S3 bucket its state
// is in, the bucket's region, and the key prefix its states are under. A person sets it on a template's
// `terraform-workspace` need. The read-only check then pushes a state of its own, past the wrapper, to a key of its own
// under that prefix — never to the workspace's state — and the account must refuse the write. Pure.

/** Where a terraform workspace keeps its state: an S3 backend. */
export interface StateBackend {
  bucket: string;
  region: string;
  /** The key prefix the workspace's states are under (`env/prod`); absent: the bucket's top. */
  keyPrefix?: string;
}

/** The directory of the check's own key, under the backend's key prefix: no workspace's state is there. */
export const STATE_PROBE_DIR = 'hopper-read-only-check';

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const KEY_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Why the hopper cannot use this backend, or undefined. */
export function backendProblem(b: StateBackend): string | undefined {
  if (!BUCKET.test(b.bucket)) return `state backend bucket ${JSON.stringify(b.bucket)} is not an S3 bucket name (lowercase letters, digits, . and -, 3 to 63)`;
  if (!REGION.test(b.region)) return `state backend region ${JSON.stringify(b.region)} is not an AWS region (as eu-west-1)`;
  if (b.keyPrefix !== undefined && (b.keyPrefix.length > 200 || !KEY_PREFIX.test(b.keyPrefix))) {
    return `state backend key prefix ${JSON.stringify(b.keyPrefix)} is not a key prefix (parts of letters, digits, . _ and -, split by /, at most 200)`;
  }
  return undefined;
}

/** The check's own key in the backend's bucket: `<key prefix>/hopper-read-only-check/terraform.tfstate`. */
export const stateProbeKey = (b: StateBackend): string => `${b.keyPrefix ? `${b.keyPrefix}/` : ''}${STATE_PROBE_DIR}/terraform.tfstate`;
