// The JOB_HOPPER_SECRET_KEY every test app runs with (design.md "Secrets at rest"): 32 fixed bytes,
// base64. A throwaway: it seals nothing outside a test database.
import type { SecretBox } from '../../src/domain/ports.ts';
import { createSecretBox } from '../../src/secrets/box.ts';

export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

/** The box a test app seals with: for unit tests of a part that takes one. */
export const testBox = (): SecretBox => createSecretBox(TEST_SECRET_KEY);
