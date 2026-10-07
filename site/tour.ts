// The front page's feature tour (issue #382): one card per part of the hopper, each with its screenshot
// once docs/screenshots has one (issue #353 captures them from a busy demo instance). A card's screenshot
// is docs/screenshots/<shot>.webp or .png; a card without one shows its words alone. Rendered at build
// time by site/vite.config.ts, which publishes the screenshots it uses beside the page.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { Cpu, GitPullRequest, ListChecks, MessageCircleQuestion, Settings2, SquareKanban, type LucideIcon } from 'lucide-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export type Feature = { shot: string; icon: LucideIcon; title: string; text: string; alt: string };

export const TOUR: Feature[] = [
  {
    shot: 'queue', icon: SquareKanban, title: 'The queue and its lanes',
    text: 'Every job waiting, held or running, in the order the hopper takes them. Each lane shows what a machine is doing now.',
    alt: 'The hopper queue: several lanes running jobs at once, with held and queued jobs waiting below them.',
  },
  {
    shot: 'job', icon: ListChecks, title: 'Follow a job as it works',
    text: 'A job\'s timeline shows what it did and what it asked, up to the pull request it opens.',
    alt: 'A running job\'s detail page, with its timeline of progress, questions and its pull request.',
  },
  {
    shot: 'question', icon: MessageCircleQuestion, title: 'Questions come to you',
    text: 'A job\'s question climbs the escalation levels. Only the ones nothing else can answer wait for you, on any screen, your phone too.',
    alt: 'A question from a job, escalated to its owner, with the answer box open.',
  },
  {
    shot: 'machines', icon: Cpu, title: 'Your machines, inside their budgets',
    text: 'Add the computers jobs run on. Live usage shows how much of each budget is left, and the hopper keeps every machine inside it.',
    alt: 'The Machines view: several online machines with their lanes and live usage.',
  },
  {
    shot: 'sources', icon: GitPullRequest, title: 'You choose what becomes a job',
    text: 'Sign in with GitHub, tick the repositories, and label an issue hopper. Nothing else can give the hopper work.',
    alt: 'The Sources view: a connected GitHub account with its selected repositories.',
  },
  {
    shot: 'settings', icon: Settings2, title: 'Every part is a plugin',
    text: 'Routing rules, job rules and plugins, all edited in the UI. Install more from the plugin store.',
    alt: 'The Settings view: routing rules, job rules and the installed plugins.',
  },
];

export type TourFile = { fileName: string; path: string };

const screenshot = (dir: string, shot: string): string | undefined =>
  ['webp', 'png'].map((ext) => join(dir, `${shot}.${ext}`)).find((p) => existsSync(p));

/** The tour's markup, and the screenshot files it names (published under screenshots/). */
export const renderTour = (dir: string): { html: string; files: TourFile[] } => {
  const files: TourFile[] = [];
  const cards = TOUR.map(({ shot, icon, title, text, alt }) => {
    const path = screenshot(dir, shot);
    let figure = null;
    if (path) {
      const fileName = `screenshots/${path.slice(path.lastIndexOf('/') + 1)}`;
      const { width, height } = imageSize(readFileSync(path));
      files.push({ fileName, path });
      figure = h('img', {
        src: fileName, alt, width, height, loading: 'lazy', decoding: 'async',
        className: 'aspect-[16/10] w-full border-b border-border object-cover object-top',
      });
    }
    return h('li', { key: shot, className: 'tour-card flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm' },
      figure,
      h('div', { className: 'flex flex-1 flex-col gap-2 p-6' },
        h('span', { className: 'grid size-9 place-items-center rounded-lg bg-[#1ecad4]/12 text-[#0e8f97] dark:text-[#1ecad4]' }, h(icon, { className: 'size-[1.05rem]', 'aria-hidden': true })),
        h('h3', { className: 'mt-2 text-base font-semibold tracking-tight' }, title),
        h('p', { className: 'text-sm leading-relaxed text-muted-foreground' }, text)));
  });
  return { html: renderToStaticMarkup(h('ul', { className: 'grid gap-5 sm:grid-cols-2 lg:grid-cols-3' }, ...cards)), files };
};
