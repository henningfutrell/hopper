// Issue #586: the KMS adapter against a real local KMS (local-kms, the compose file's `kms` service). It runs only when
// HOPPER_TEST_KMS_URL names one on loopback, e.g. `podman run -d -p 127.0.0.1:8080:8080 docker.io/nsmithuk/local-kms:3`.
//
// Feature: the vault's data key, made and opened by a local KMS
//   Scenario: a KMS with no key for the vault yet: the key is made, and a data key wrapped by it opens again
//   Scenario: a wrapped data key that was changed does not open
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localKms } from '../../src/vault/kms.ts';

const url = process.env.HOPPER_TEST_KMS_URL;

describe.skipIf(!url)('the vault\'s data key through a local KMS (issue #586)', () => {
  it('makes the vault\'s key when the KMS has none, and opens the data key it wrapped', async () => {
    const kms = localKms({ url: url!, key: `alias/hopper-test-${randomUUID()}` });
    const { plain, wrapped } = await kms.newDataKey();
    expect(plain).toHaveLength(32);
    expect(Buffer.from(wrapped, 'base64').includes(plain)).toBe(false);
    expect((await kms.unwrap(wrapped)).equals(plain)).toBe(true);
    // The key exists now: a second data key is made under it, not a second key.
    const second = await kms.newDataKey();
    expect((await kms.unwrap(second.wrapped)).equals(second.plain)).toBe(true);
  });

  it('a wrapped data key that was changed does not open', async () => {
    const kms = localKms({ url: url!, key: `alias/hopper-test-${randomUUID()}` });
    const { wrapped } = await kms.newDataKey();
    const bytes = Buffer.from(wrapped, 'base64');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await expect(kms.unwrap(bytes.toString('base64'))).rejects.toThrow();
  });
});
