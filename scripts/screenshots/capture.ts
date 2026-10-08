// `npm run screenshots` (issue #353): starts the busy demo hopper (demo.ts), photographs its UI with
// Playwright's Chromium, and writes every screenshot to docs/screenshots as WebP — the README, the install
// docs and the Pages site's tour (site/tour.ts) show them. Re-run it when the UI changes.
// Needs the built UI (`npm run build:ui`), Chromium for Playwright (`npx playwright install chromium`) and
// Postgres: HOPPER_TEST_POSTGRES_URL, else a throwaway container as `npm test` starts one (docker).
// SHOTS=queue,job limits the run to those shots.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import sharp from 'sharp';
import { startDemo, type Demo } from './demo.ts';

const OUT = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const QUALITY = 80;
/** The same clock face and words on every machine that runs it. */
const LOOK = { locale: 'en-US', timezoneId: 'UTC' } as const;

interface Shot {
  name: string;
  viewport?: { width: number; height: number };
  /** Device pixels per CSS pixel; phone shots are taken at 2, as a phone shows them. */
  scale?: number;
  signedOut?: boolean;
  go(page: Page): Promise<void>;
  /** What to photograph: the viewport, unless a locator is given. */
  pick?(page: Page): ReturnType<Page['locator']>;
}

const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);
const view = (hash: string) => async (page: Page) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await settle(page);
};

const SHOTS: Shot[] = [
  { name: 'queue', viewport: { width: 1440, height: 1010 }, go: view('#overview') },
  {
    name: 'job', viewport: { width: 1440, height: 1010 },
    async go(page) {
      await view('#overview')(page);
      // A run's tooltip: the job that asked, its question strip along the foot of its lane.
      const wait = page.locator('[data-overview-panel=timeline] rect[data-wait]').first();
      await wait.hover({ force: true });
      await settle(page, 500);
    },
    pick: (page) => page.locator('[data-overview-panel=timeline]'),
  },
  {
    name: 'question', viewport: { width: 1440, height: 760 },
    async go(page) {
      await view('#questions')(page);
      await page.getByPlaceholder('Answer to type into the job').fill('Add the grace period: read both stores for a week, then drop the old table in a follow-up.');
      await settle(page, 300);
    },
  },
  { name: 'machines', viewport: { width: 1440, height: 960 }, go: view('#machines') },
  { name: 'sources', viewport: { width: 1440, height: 820 }, go: view('#sources') },
  { name: 'settings', go: view('#settings/routing') },
  { name: 'job-rules', go: view('#settings/job-rules') },
  { name: 'plugins', go: view('#settings/plugins') },
  { name: 'queue-order', go: view('#queue') },
  { name: 'sign-in', signedOut: true, go: (page) => settle(page, 2500) },
  { name: 'phone', viewport: PHONE, scale: 2, go: view('#overview') },
  { name: 'phone-question', viewport: PHONE, scale: 2, go: view('#questions') },
];

/** The page reaches the demo hopper and nothing else. */
const sealed = (context: BrowserContext) => context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());

/** The Postgres the demo keeps its data in: HOPPER_TEST_POSTGRES_URL, else a throwaway container (as `npm test`). */
async function postgres(): Promise<() => Promise<void>> {
  if (process.env.HOPPER_TEST_POSTGRES_URL) return async () => {};
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine').start();
  process.env.HOPPER_TEST_POSTGRES_URL = container.getConnectionUri();
  return async () => { await container.stop(); };
}

async function webp(png: Buffer, name: string, width?: number): Promise<void> {
  const img = sharp(png);
  await (width ? img.resize({ width }) : img).webp({ quality: QUALITY }).toFile(join(OUT, `${name}.webp`));
  console.log(`docs/screenshots/${name}.webp`);
}

async function take(browser: Browser, demo: Demo, token: string, shot: Shot): Promise<void> {
  const context = await browser.newContext({ viewport: shot.viewport ?? DESKTOP, deviceScaleFactor: shot.scale ?? 1, colorScheme: 'dark', ...LOOK });
  if (!shot.signedOut) await context.addInitScript((t) => localStorage.setItem('jh_session', t), token);
  await sealed(context);
  const page = await context.newPage();
  await page.goto(`${demo.url}/`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await shot.go(page);
  const png = shot.pick ? await shot.pick(page).screenshot() : await page.screenshot();
  // Phone shots are kept at their CSS width × 2; the others at their own size.
  await webp(png, shot.name, shot.scale ? shot.viewport!.width * 2 : undefined);
  await context.close();
}

/** Lanes picking up and finishing jobs: the Lanes and Waiting panels, a frame every `stepMs`, as animated WebP. */
async function animate(browser: Browser, demo: Demo, token: string, frames = 40, stepMs = 1500): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 }, colorScheme: 'dark', ...LOOK });
  await context.addInitScript((t) => localStorage.setItem('jh_session', t), token);
  await sealed(context);
  const page = await context.newPage();
  await page.goto(`${demo.url}/#overview`);
  await settle(page, 2500);
  const lanes = await page.locator('[data-overview-panel=lanes]').boundingBox();
  const waiting = await page.locator('[data-overview-panel=waiting]').boundingBox();
  if (!lanes || !waiting) throw new Error('screenshots: the Lanes and Waiting panels are not on the overview');
  const clip = { x: lanes.x, y: lanes.y, width: waiting.x + waiting.width - lanes.x, height: Math.max(lanes.height, waiting.height) };
  const shots: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    shots.push(await sharp(await page.screenshot({ clip })).resize({ width: 800 }).png().toBuffer());
    await page.waitForTimeout(stepMs);
  }
  await sharp(shots, { join: { animated: true } }).webp({ quality: 70, delay: shots.map(() => 400), loop: 0 }).toFile(join(OUT, 'lanes.webp'));
  console.log('docs/screenshots/lanes.webp');
  await context.close();
}

const only = process.env.SHOTS?.split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });
const stopPostgres = await postgres();
const demo = await startDemo({ log: (s) => console.log(s) });
const browser = await chromium.launch();
try {
  const token = await demo.app.login();
  // The film first: the demo's short jobs end during it (demo.ts LIVE).
  if (!only || only.includes('lanes')) await animate(browser, demo, token);
  for (const shot of SHOTS) if (!only || only.includes(shot.name)) await take(browser, demo, token, shot);
} finally {
  await browser.close();
  await demo.stop();
  await stopPostgres();
}
process.exit(0);
