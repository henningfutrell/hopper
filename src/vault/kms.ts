// The KMS (issue #586, design.md "The KMS: an optional key provider"): an outside key service the vault's data key is
// made and wrapped by — envelope encryption. Optional, never required: unset, the vault seals under the master key. It
// speaks AWS KMS's API, through AWS's own client. Two: a local KMS (local-kms, the compose file's `kms` service), which
// checks no credentials, so the client sends fixed placeholder ones; and AWS KMS itself (issue #1288), with the AWS
// client's own credentials (an EKS service account's role, the instance's role, the AWS_* variables), whose key an
// operator makes: the hopper never makes a key in AWS.
import { AWS_REGION_PATTERN, DEFAULT_KMS_KEY, KMS_KEY_VARIABLE, KMS_REGION_VARIABLE, KMS_URL_VARIABLE, type KmsSettings } from './wire.ts';
import { CreateAliasCommand, CreateKeyCommand, DecryptCommand, DescribeKeyCommand, GenerateDataKeyCommand, KMSClient, type KMSClientConfig } from '@aws-sdk/client-kms';

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

  return wrapping(client, o.url, o.key, ensureKey);
}

/**
 * AWS KMS in `region` (issue #1288), at `url` when it names an endpoint (a VPC endpoint), else the region's own. `key`
 * is the KMS key's id, ARN or alias, which must be there: a key that is not answers the KMS's error. The credentials are
 * the AWS client's own chain, unless given.
 */
export function awsKms(o: { region: string; key: string; url?: string; credentials?: KMSClientConfig['credentials'] }): KeyService {
  const client = new KMSClient({ region: o.region, ...(o.url ? { endpoint: o.url } : {}), ...(o.credentials ? { credentials: o.credentials } : {}), maxAttempts: 3 });
  return wrapping(client, o.url ?? `https://kms.${o.region}.amazonaws.com`, o.key, async () => {});
}

/** The KMS `settings` name. */
export function keyServiceOf(settings: KmsSettings): KeyService {
  return settings.region !== undefined ? awsKms({ region: settings.region, key: settings.key, ...(settings.url ? { url: settings.url } : {}) }) : localKms({ url: settings.url, key: settings.key });
}

function wrapping(client: KMSClient, url: string, key: string, ensureKey: () => Promise<void>): KeyService {
  return {
    url,
    async newDataKey() {
      await ensureKey();
      const r = await client.send(new GenerateDataKeyCommand({ KeyId: key, KeySpec: 'AES_256', EncryptionContext: CONTEXT }));
      return { plain: Buffer.from(r.Plaintext!), wrapped: Buffer.from(r.CiphertextBlob!).toString('base64') };
    },
    async unwrap(wrapped) {
      const r = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64'), EncryptionContext: CONTEXT }));
      return Buffer.from(r.Plaintext!);
    },
  };
}

/**
 * The KMS `env` names, or none: HOPPER_KMS_REGION names AWS KMS (HOPPER_KMS_URL then its endpoint), HOPPER_KMS_URL alone
 * the local KMS; neither, none. Throws on a URL that is no http(s) URL and on a region that is no AWS region.
 */
export function kmsOf(env: Record<string, string | undefined>): KeyService | undefined {
  const url = env[KMS_URL_VARIABLE] || undefined;
  const region = env[KMS_REGION_VARIABLE] || undefined;
  if (url !== undefined && (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))) throw new Error(`${KMS_URL_VARIABLE} must be an http(s) URL`);
  if (region !== undefined && !AWS_REGION_PATTERN.test(region)) throw new Error(`${KMS_REGION_VARIABLE} must be an AWS region, as eu-west-1`);
  const key = env[KMS_KEY_VARIABLE] || DEFAULT_KMS_KEY;
  if (region !== undefined) return keyServiceOf({ region, key, ...(url ? { url } : {}) });
  return url === undefined ? undefined : keyServiceOf({ url, key });
}
