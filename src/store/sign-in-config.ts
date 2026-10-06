// The sign-in config (design.md "Sign-in: realms"): the instance's config record `sign-in` (the realms,
// the login code, no sign-in), read as one value and replaced by compare-and-swap against the version
// read, so it holds across processes too.
import { createHash } from 'node:crypto';
import type { ConfigRecords, InstanceConfigName, SignInConfigRepository, StoredSignIn } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

const SIGN_IN = 'sign-in';

const versionOf = (s: StoredSignIn): string => createHash('sha256').update(JSON.stringify(s)).digest('hex');

export function createSignInConfigRepository(c: StoreContext, config: ConfigRecords<InstanceConfigName>): SignInConfigRepository {
  const read = (): StoredSignIn => {
    const record = (config.read(SIGN_IN) ?? { version: 1 }) as Omit<StoredSignIn, 'realms'> & { realms?: StoredSignIn['realms'] };
    return { ...record, realms: record.realms ?? [] };
  };
  return {
    read,
    version: () => versionOf(read()),
    write(next, version) {
      return c.tx(() => {
        if (versionOf(read()) !== version) return false;
        return config.write(SIGN_IN, next, config.version(SIGN_IN));
      });
    },
  };
}
