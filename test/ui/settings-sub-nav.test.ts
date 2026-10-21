// @vitest-environment happy-dom
// Settings' sub-nav and the sections that left it (issue #2373): Settings lists its sections in a left sub-nav of six groups,
// configuration only; Users & access, Plugins and Vault are views of their own in the sidebar, and an old hash of one of
// them opens its new home. On Plugins each block is a card that folds, with a one-line summary, and Fold all folds them.
import { afterEach, describe, expect, it } from 'vitest';
import { all, boot, click, settle, unmount } from './long-page-harness.ts';

afterEach(unmount);

const PLUGINS = {
  roles: ['router', 'executor'],
  config: { source: 'stored', version: 'p1', warnings: [] },
  instances: [{ role: 'executor', instance: { name: 'test', plugin: 'test' } }],
  router: { instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' }, active: 'pass-through', fallback: false },
  escalationLevels: [],
  executors: { instances: [{ instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' }] },
  jobSources: { instances: [] }, machines: { instances: [] }, usageSources: { instances: [] }, notifiers: { instances: [] }, vaultBackends: { instances: [] },
  plugins: [
    { id: 'pass-through', role: 'router', describe: 'pass-through', builtin: true, detection: { status: 'available' }, options: {} },
    { id: 'test', role: 'executor', describe: 'test', builtin: true, detection: { status: 'available' }, options: {} },
    { id: 'cursor-agent', role: 'executor', describe: 'cursor', builtin: true, detection: { status: 'available' }, options: {} },
  ],
  errors: [], warnings: [],
};

const LEFT = ['plugins', 'vault', 'users', 'access', 'permissions', 'api-tokens'];

describe('Settings sub-nav (issue #2373)', () => {
  it('groups its sections in six groups, each with more than one section, and no section that left it', async () => {
    await boot('#settings');
    const nav = document.querySelector('[data-slot="settings-nav"]')!;
    expect(nav.getAttribute('aria-orientation')).toBe('vertical');
    const groups = all('[data-settings-group]');
    expect(groups.map((g) => g.querySelector('[data-slot="settings-group-toggle"]')?.textContent?.replace(/\d+$/, ''))).toEqual(
      ['Jobs and agents', 'Intake', 'GitHub', 'Security and access', 'Integrations', 'System']);
    for (const g of groups) expect(g.querySelectorAll('a[href^="#settings/"]').length).toBeGreaterThan(1);
    const hrefs = groups.flatMap((g) => [...g.querySelectorAll('a[href^="#settings/"]')].map((a) => a.getAttribute('href')));
    for (const s of LEFT) expect(hrefs).not.toContain(`#settings/${s}`);
    expect(hrefs).toContain('#settings/sign-in');
    expect(hrefs).toContain('#settings/webhooks');
  });

  it('gives Users & access, Plugins and Vault their own sidebar entries', async () => {
    await boot('#settings');
    const aside = document.querySelector('aside')!;
    for (const href of ['#users-access', '#plugins', '#vault', '#settings']) expect(aside.querySelector(`a[href="${href}"]`)).not.toBeNull();
    for (const g of all('[data-nav-group]')) expect(g.querySelectorAll('a').length).toBeGreaterThan(1);
  });

  it.each([
    ['#settings/plugins', '#plugins'],
    ['#settings/vault', '#vault'],
    ['#settings/users', '#users-access/users'],
    ['#settings/access', '#users-access/access'],
    ['#settings/permissions', '#users-access/permissions'],
    ['#settings/api-tokens', '#users-access/api-tokens'],
    ['#settings/api-tokens/BCDF-GHJK', '#users-access/api-tokens/BCDF-GHJK'],
  ])('sends the old hash %s to its new home %s', async (from, to) => {
    await boot(from, { '/api/plugins': PLUGINS });
    await settle();
    expect(window.location.hash).toBe(to);
  });

  it('shows Users & access with its four sections', async () => {
    await boot('#users-access');
    const links = [...document.querySelectorAll('[data-slot="users-access-nav"] a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#users-access/users', '#users-access/access', '#users-access/permissions', '#users-access/api-tokens']);
    expect(document.querySelector('[data-slot="users-access-nav"] a[aria-current="page"]')?.getAttribute('href')).toBe('#users-access/users');
  });
});

describe('Plugins as folding cards (issue #2373)', () => {
  it('folds each block to its title and a one-line summary, and Fold all folds every block', async () => {
    await boot('#plugins', { '/api/plugins': PLUGINS, '/api/plugin-store': { sources: [], plugins: [] } });
    const cards = all('[data-slot="plugins"] [data-open]');
    expect(cards.length).toBeGreaterThanOrEqual(4);
    for (const c of cards) {
      expect(c.querySelector('[data-slot="panel-toggle"]')).not.toBeNull();
      expect(c.querySelector('[data-slot="panel-summary"]')?.textContent).not.toBe('');
    }
    const executors = cards.find((c) => c.textContent?.includes('Executors'))!;
    expect(executors.querySelector('[data-slot="panel-summary"]')?.textContent).toBe('1 instance: test');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Fold all'));
    for (const c of all('[data-slot="plugins"] [data-open]')) {
      expect(c.getAttribute('data-open')).toBe('false');
      expect(c.querySelector('[data-slot="panel-body"]')).toBeNull();
    }
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Open all'));
    for (const c of all('[data-slot="plugins"] [data-open]')) expect(c.getAttribute('data-open')).toBe('true');
  });
});
