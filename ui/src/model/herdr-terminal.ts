// The herdr view's model (issue #189, design.md "The herdr terminal"): the socket's URL, the messages
// the terminal sends, and each machine's line. Pure.
import type { HerdrTerminalMachine } from './wire.ts';

export interface Size { cols: number; rows: number }

/** The terminal's socket on this page's host: wss behind https. */
export const socketUrl = (page: { protocol: string; host: string }, ticket: string, size: Size): string =>
  `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ui/api/herdr-terminal/socket?ticket=${encodeURIComponent(ticket)}&cols=${size.cols}&rows=${size.rows}`;

export const inputMessage = (data: string): string => JSON.stringify({ type: 'input', data });
export const resizeMessage = (size: Size): string => JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows });

export type Tone = 'good' | 'bad' | 'neutral' | 'muted';

export function machineLine(m: HerdrTerminalMachine): { tone: Tone; text: string } {
  if (!m.listed) return { tone: 'muted', text: `not listed: ${m.reason ?? 'unknown'}` };
  if (m.sync === 'failed') return { tone: 'bad', text: `herdr could not save it: ${m.error ?? 'unknown'}` };
  if (m.sync === 'saved') return { tone: 'good', text: 'in the sidebar' };
  return { tone: 'neutral', text: 'listed' };
}
