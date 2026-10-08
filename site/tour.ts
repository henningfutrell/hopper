// The front page's feature tour (issue #382): one card per part of the hopper, each with its screenshot
// once docs/screenshots has one (issue #353 captures them from a busy demo instance). A card's screenshot
// is docs/screenshots/<shot>.webp or .png (`npm run screenshots` makes them); a card without one shows its words alone. Rendered at build
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
    alt: 'The hopper overview: nine lanes on four machines running jobs at once, the lane timeline, and the waiting queue with held jobs.',
  },
  {
    shot: 'job', icon: ListChecks, title: 'Follow every job as it works',
    text: 'The lane timeline shows what each lane ran, how each run ended, and where a job waited on a question.',
    alt: 'The lane timeline: finished and failed runs on each lane over the last hour, jobs running now, and a hovered job waiting on its answer.',
  },
  {
    shot: 'question', icon: MessageCircleQuestion, title: 'Questions come to you',
    text: 'A job\'s question climbs the escalation levels. Only the ones nothing else can answer wait for you, on any screen, your phone too.',
    alt: 'A question from a job, escalated past both escalation levels to its owner, with an answer typed in the answer box.',
  },
  {
    shot: 'machines', icon: Cpu, title: 'Your machines, inside their budgets',
    text: 'Add the computers jobs run on. Live usage shows how much of each budget is left, and the hopper keeps every machine inside it.',
    alt: 'The Machines view: four online machines, each with its lanes and live usage of the session and the week.',
  },
  {
    shot: 'sources', icon: GitPullRequest, title: 'You choose what becomes a job',
    text: 'Sign in with GitHub, tick the repositories, and label an issue hopper. Nothing else can give the hopper work.',
    alt: 'The Sources view: a connected GitHub account with four of its repositories chosen for jobs.',
  },
  {
    shot: 'settings', icon: Settings2, title: 'Every part is a plugin',
    text: 'Routing rules, job rules and plugins, all edited in the UI. Install more from the plugin store.',
    alt: 'Settings → Routing: the router, the queue sorter and three routing rules.',
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
