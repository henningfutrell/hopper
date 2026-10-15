// The header badges' setting (issue #1181), apart from settings.ts for its size: a user's key-value setting, absent when
// never set.
import { inCardOrder, type HeaderBadgeSettings } from '../domain/header-badges.ts';

export function headerBadgeSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getHeaderBadges(): HeaderBadgeSettings | undefined;
  setHeaderBadges(settings: HeaderBadgeSettings): void;
} {
  return {
    getHeaderBadges() {
      const text = read('headerBadges');
      return text === undefined ? undefined : { badges: inCardOrder((JSON.parse(text) as HeaderBadgeSettings).badges) };
    },
    setHeaderBadges(settings) {
      write('headerBadges', JSON.stringify({ badges: inCardOrder(settings.badges) }));
    },
  };
}
