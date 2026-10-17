// The cloud link's record (issue #467), apart from settings.ts for its size: the instance's key-value setting
// `cloudLink`, absent while this install is not linked, and its open registration code (issue #465),
// `cloudRegistrationCode`, only hashed. An unlink deletes both rows, so nothing of the link stays.
import { cloudLinkRecord, type CloudLinkSettings, type CloudRegistrationCode } from '../domain/cloud-link.ts';

export function cloudLinkSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void, remove: (key: string) => void): {
  getCloudLink(): CloudLinkSettings | undefined;
  setCloudLink(link: CloudLinkSettings): void;
  removeCloudLink(): void;
  getCloudRegistrationCode(): CloudRegistrationCode | undefined;
  setCloudRegistrationCode(code: CloudRegistrationCode): void;
  removeCloudRegistrationCode(): void;
} {
  return {
    getCloudLink() {
      const text = read('cloudLink');
      return text === undefined ? undefined : JSON.parse(text) as CloudLinkSettings;
    },
    setCloudLink: (link) => write('cloudLink', JSON.stringify(cloudLinkRecord(link))),
    removeCloudLink: () => remove('cloudLink'),
    getCloudRegistrationCode() {
      const text = read('cloudRegistrationCode');
      return text === undefined ? undefined : JSON.parse(text) as CloudRegistrationCode;
    },
    setCloudRegistrationCode: (c) => write('cloudRegistrationCode', JSON.stringify({ codeHash: c.codeHash, expiresAt: c.expiresAt, by: c.by })),
    removeCloudRegistrationCode: () => remove('cloudRegistrationCode'),
  };
}
