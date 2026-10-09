// The KMS (issue #586, design.md "The KMS: an optional key provider"): an outside key service the vault's data key is
// made and wrapped by — envelope encryption. Optional, never required: unset, the vault seals under the token key. It
// speaks AWS KMS's API, through AWS's own client; the one built and documented is a local KMS (local-kms, the compose
// file's `kms` service), which checks no credentials, so the client sends fixed placeholder ones.
import { DEFAULT_KMS_KEY, KMS_KEY_VARIABLE, KMS_URL_VARIABLE } from './wire.ts';
import { CreateAliasCommand, CreateKeyCommand, DecryptCommand, DescribeKeyCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

/** The port: what the vault asks a KMS. */
export interface KeyService {
  /** Where the KMS is: said in a problem, never a secret. */
  readonly url: string;
  /** A new data key: in clear, for this process only, and wrapped by the KMS's key, to keep. */
  newDataKey(): Promise<{ plain: Buffer; wrapped: string }>;
  /** A kept data key, opened by the KMS; throws when it does not open. */
  unwrap(wrapped: string): Promise<Buffer>;
}

/** Bound to every data key the KMS wraps for the vault: a blob wrapped for anything else does not open here. */
const CONTEXT = { hopper: 'vault data key v1' };

const isNotFound = (e: unknown): boolean => (e as { name?: string }).name === 'NotFoundException';

/** A local KMS at `url`; `key` is the KMS key's id or alias, made (with its alias) when the KMS has none. */
export function localKms(o: { url: string; key: string }): KeyService {
  const client = new KMSClient({ endpoint: o.url, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 2 });

  async function ensureKey(): Promise<void> {
    try {
      await client.send(new DescribeKeyCommand({ KeyId: o.key }));
    } catch (e) {
      if (!isNotFound(e) || !o.key.startsWith('alias/')) throw e;
      const made = await client.send(new CreateKeyCommand({ Description: 'hopper vault: wraps each user\'s data key' }));
      await client.send(new CreateAliasCommand({ AliasName: o.key, TargetKeyId: made.KeyMetadata!.KeyId! }));
    }
  }

  return {
    url: o.url,
    async newDataKey() {
      await ensureKey();
      const r = await client.send(new GenerateDataKeyCommand({ KeyId: o.key, KeySpec: 'AES_256', EncryptionContext: CONTEXT }));
      return { plain: Buffer.from(r.Plaintext!), wrapped: Buffer.from(r.CiphertextBlob!).toString('base64') };
    },
    async unwrap(wrapped) {
      const r = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64'), EncryptionContext: CONTEXT }));
      return Buffer.from(r.Plaintext!);
    },
  };
}

/** The KMS `env` names, or none: HOPPER_KMS_URL unset or empty. Throws on a URL that is no http(s) URL. */
export function kmsOf(env: Record<string, string | undefined>): KeyService | undefined {
  const url = env[KMS_URL_VARIABLE] || undefined;
  if (url === undefined) return undefined;
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error(`${KMS_URL_VARIABLE} must be an http(s) URL`);
  return localKms({ url, key: env[KMS_KEY_VARIABLE] || DEFAULT_KMS_KEY });
}
