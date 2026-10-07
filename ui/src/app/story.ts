// What the hopper is, told the same way wherever it is told (issues #266, #382): the signed-out landing
// page (landing.tsx) and the GitHub Pages front page (site/, rendered at build time) both render these.
// Plain createElement, no JSX, and no `@/` imports: the site's Vite config loads this module in Node.
// The classes are the UI's own; their look is index.css "landing".
import { Cpu, GitPullRequest, Tag, type LucideIcon } from 'lucide-react';
import { createElement as h } from 'react';

export const KICKER = 'A job queue for coding agents';
export const HEADLINE = 'Your GitHub issues, worked on your machines.';
export const LEAD = 'hopper takes the issues you choose, runs each one on a computer you trust, and keeps you in the loop.';

export const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Tag, title: 'Label an issue', text: 'Give a GitHub issue the hopper label: it is a job now.' },
  { icon: Cpu, title: 'It runs on your machine', text: 'A coding agent works on it, on a machine of yours, inside its usage budget.' },
  { icon: GitPullRequest, title: 'Review the pull request', text: 'The work comes back as a pull request. A question it cannot answer comes to you.' },
];

/** The night sky behind the story: aurora light, a dot grid, and lanes with jobs going along them. */
export const Backdrop = () =>
  h('div', { className: 'landing-backdrop', 'aria-hidden': true },
    h('div', { className: 'landing-aurora a' }),
    h('div', { className: 'landing-aurora b' }),
    h('div', { className: 'landing-aurora c' }),
    h('div', { className: 'landing-grid' }),
    h('div', { className: 'landing-lanes' }, ...[0, 1, 2, 3, 4, 5].map((i) => h('div', { key: i, className: 'landing-lane' }))),
    h('div', { className: 'landing-grain' }),
    h('div', { className: 'landing-vignette' }));

/** What the hopper does, in three steps joined by a lane. `heading` is the level of each step's title. */
export const StorySteps = ({ heading = 'h3' }: { heading?: 'h2' | 'h3' }) =>
  h('ol', { className: 'landing-steps relative flex flex-col gap-6' },
    ...STEPS.map(({ icon, title, text }) =>
      h('li', { key: title, 'data-landing-step': '', className: 'relative flex items-start gap-4' },
        h('span', { className: 'relative z-10 grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-card/80 text-[#1ecad4] shadow-lg shadow-black/40 backdrop-blur' },
          h(icon, { className: 'size-[1.1rem]', 'aria-hidden': true })),
        h('div', { className: 'pt-1' },
          h(heading, { className: 'text-sm font-semibold text-foreground' }, title),
          h('p', { className: 'mt-0.5 text-sm leading-relaxed text-muted-foreground' }, text)))));
