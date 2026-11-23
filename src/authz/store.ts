// The OpenFGA store Access pushes to (issue #2988): the hopper's own, `hopper`, made when the server holds none and kept
// in the instance schema; or the **provisioned store** HOPPER_OPENFGA_STORE_ID names, used as it is and never made. A
// provisioned store OpenFGA does not hold stops the start, and is a deny with that reason at every push after.
import type { AuthorizationServer } from '../domain/ports.ts';

const STORE_NAME = 'hopper';

/** What a provisioned store OpenFGA does not hold says. */
export const storeMissing = (id: string): string =>
  `OpenFGA holds no store ${id}, the one HOPPER_OPENFGA_STORE_ID names: set the id of the store provisioned for the hopper, or unset it and the hopper makes its own`;

/** The store a push goes to: the provisioned one once OpenFGA holds it, else the hopper's own, made when missing, and kept. */
export async function pushStore(server: AuthorizationServer, provisioned: string | undefined, kept: { get(): string | undefined; set(id: string): void }): Promise<string> {
  if (provisioned !== undefined) {
    if (!(await server.hasStore(provisioned))) throw new Error(storeMissing(provisioned));
    return provisioned;
  }
  const id = await server.store(kept.get(), STORE_NAME);
  if (id !== kept.get()) kept.set(id);
  return id;
}

/**
 * At start: a provisioned store OpenFGA does not hold stops the start. OpenFGA not reached does not: it may start after the
 * hopper, and until it answers every check is a deny, as always.
 */
export async function checkProvisionedStore(server: AuthorizationServer, id: string, logger: { warn(line: string): void }): Promise<void> {
  let held: boolean;
  try {
    held = await server.hasStore(id);
  } catch (e) {
    logger.warn(`hopper: access: cannot check the OpenFGA store HOPPER_OPENFGA_STORE_ID names now: ${(e as Error).message}`);
    return;
  }
  if (!held) throw new Error(`invalid configuration: ${storeMissing(id)}`);
}
