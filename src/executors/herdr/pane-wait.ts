// Waiting for what a command typed into a pane prints (issue #518): by the hopper's own clock, read off the screen.
import type { ExecutionContext } from '../../domain/ports.ts';
import type { StartDeps } from './start.ts';

/** What waiting on a pane needs of the start's dependencies. */
export type PaneWaitDeps = Pick<StartDeps, 'herdr' | 'clock' | 'sleep' | 'pollMs'>;

/**
 * What `parse` reads on the pane once it shows, waiting up to `ms` by the hopper's own clock (issue #518): herdr's
 * wait-output on some machines answered within seconds, the text not there yet, so its answer only says when to
 * look at the screen, never what is on it. Undefined when `ms` passed (or the signal fired) first, with the screen.
 */
export async function awaitOnScreen<T>(d: PaneWaitDeps, ctx: ExecutionContext, paneId: string, mark: string, parse: (screen: string) => T | undefined, ms: number): Promise<{ found?: T; screen: string }> {
  const until = d.clock.now().getTime() + ms;
  for (;;) {
    await d.herdr.waitOutput(paneId, mark, Math.max(1, until - d.clock.now().getTime()));
    const screen = await d.herdr.read(paneId, { source: 'recent-unwrapped', lines: 40 });
    const found = parse(screen);
    if (found !== undefined) return { found, screen };
    if (ctx.signal.aborted || d.clock.now().getTime() >= until) return { screen };
    await d.sleep(d.pollMs, ctx.signal);
  }
}

/** Whether a line of the screen is `line`. */
export const shows = (line: string) => (screen: string): true | undefined => (screen.split('\n').some((l) => l.trim() === line) ? true : undefined);
