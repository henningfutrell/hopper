// A vault backend's own credential (issue #585): given to the hopper by the runtime, as every credential for an outside
// service is (design.md "Secrets") — the variable an option names, or the file that variable's `_FILE` names, read at
// each use, so a rotated token applies without a restart. Never in the plugins config, never logged.
import type { DetectionKit, PluginContext } from '../sdk.ts';

/** The credential now; throws, naming the variable as the runtime reads it, when it is not given. */
export function credentialOf(rt: Pick<PluginContext, 'env' | 'secretName'>, name: string): string {
  const v = rt.env(name)?.trim();
  if (!v) throw new Error(`${rt.secretName(name)} is not set: give the backend's token in the runtime, or ${rt.secretName(name)}_FILE naming a file that holds it`);
  return v;
}

/** Detection of a backend whose only need is its credential: needs-setup, saying where to give it, until it is given. */
export function credentialDetection(sys: Pick<DetectionKit, 'env' | 'secretName'>, name: string, what: string) {
  try {
    credentialOf(sys, name);
    return { status: 'available' as const, detail: sys.secretName(name) };
  } catch (e) {
    return { status: 'needs-setup' as const, reason: (e as Error).message, command: `set ${sys.secretName(name)} (or ${sys.secretName(name)}_FILE) in the hopper's runtime to ${what}` };
  }
}

/** One client per credential: made on first use, made again when the credential changes. */
export function clientPerCredential<C>(make: (credential: string) => Promise<C>): (credential: string) => Promise<C> {
  let held: { credential: string; client: Promise<C> } | undefined;
  return (credential) => {
    if (held?.credential !== credential) {
      const client = make(credential);
      held = { credential, client };
      // A client that could not be made is made again at the next use.
      client.catch(() => { if (held?.client === client) held = undefined; });
    }
    return held.client;
  };
}
