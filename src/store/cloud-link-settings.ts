// The cloud link's record (issue #467), apart from settings.ts for its size: the instance's key-value setting
// `cloudLink`, absent while this install is not linked. An unlink deletes the row, so nothing of the link stays.
import { cloudLinkRecord, type CloudLinkSettings } from '../domain/cloud-link.ts';

export function cloudLinkSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void, remove: (key: string) => void): {
  getCloudLink(): CloudLinkSettings | undefined;
  setCloudLink(link: CloudLinkSettings): void;
  removeCloudLink(): void;
} {
  return {
    getCloudLink() {
      const text = read('cloudLink');
      return text === undefined ? undefined : JSON.parse(text) as CloudLinkSettings;
    },
    setCloudLink: (link) => write('cloudLink', JSON.stringify(cloudLinkRecord(link))),
    removeCloudLink: () => remove('cloudLink'),
  };
}
