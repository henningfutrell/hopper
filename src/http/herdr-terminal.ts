// The herdr terminal's HTTP edge (issue #189, design.md "The herdr terminal"). GET /api/herdr-terminal
// reads the root herdr session and which machines it lists. The terminal itself is a WebSocket,
// GET /ui/api/herdr-terminal/socket: a browser's WebSocket sends no session header, so an admin's UI
// session first mints a ticket (POST /ui/api/herdr-terminal/ticket, ui/index.ts) — random, kept only
// hashed, good for 30 s and for one presentation, refused or not — and the socket opens with it from a
// UI origin. Text frames: the screen out; JSON in — `{type:'input',data}`, `{type:'resize',cols,rows}`.
import { createHash } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import { uiOrigins, type Lan } from './reach.ts';
import type { TenantParts, Tenants } from './tenants.ts';
import { randomSecret } from './ui/secret.ts';

export const TICKET_MS = 30000;

export interface TerminalTickets {
  /** A new ticket for this user's terminal. */
  mint(userId: string): string;
  /** The user a live ticket was minted for; the ticket is gone after this either way. */
  take(ticket: string | undefined): string | undefined;
}

const hashOf = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

export function createTerminalTickets(clock: Clock): TerminalTickets {
  const live = new Map<string, { userId: string; until: number }>();
  return {
    mint(userId) {
      const now = clock.now().getTime();
      for (const [k, v] of live) if (v.until <= now) live.delete(k);
      const ticket = randomSecret();
      live.set(hashOf(ticket), { userId, until: now + TICKET_MS });
      return ticket;
    },
    take(ticket) {
      if (!ticket) return undefined;
      const key = hashOf(ticket);
      const t = live.get(key);
      live.delete(key);
      return t && t.until > clock.now().getTime() ? t.userId : undefined;
    },
  };
}

const size = z.coerce.number().int().min(2).max(1000);
export const socketQuery = z.object({ ticket: z.string().optional(), cols: size, rows: size });
const message = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), data: z.string() }),
  z.strictObject({ type: z.literal('resize'), cols: size, rows: size }),
]);

export function herdrTerminalRoutes(app: FastifyInstance, o: {
  tenant: (req: FastifyRequest) => TenantParts; tenants: Tenants; tickets: TerminalTickets; port: () => number; lan: Lan;
}): void {
  app.get('/api/herdr-terminal', async (req) => o.tenant(req).herdrTerminal.status());

  const opened = new WeakMap<FastifyRequest, { parts: TenantParts; cols: number; rows: number }>();
  void app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: 1 << 20 } });
    scope.get('/ui/api/herdr-terminal/socket', {
      websocket: true,
      preValidation: async (req, reply) => {
        const q = socketQuery.safeParse(req.query);
        const userId = o.tickets.take(q.success ? q.data.ticket : undefined);
        const refuse = (code: number, why: string) => {
          console.warn(`hopper: herdr terminal refused from ${req.socket.remoteAddress}: ${why}`);
          return reply.code(code).send({ error: why });
        };
        if (userId === undefined) return refuse(401, 'missing, used or expired ticket: mint one with POST /ui/api/herdr-terminal/ticket');
        const origin = req.headers.origin?.toLowerCase();
        if (origin === undefined || !uiOrigins(o.port(), o.lan).includes(origin)) return refuse(403, `origin ${origin ?? '(none)'} not allowed`);
        if (!q.success) return refuse(400, 'cols and rows must be whole numbers from 2 to 1000');
        const parts = o.tenants.user(userId);
        if (!parts) return refuse(404, `no user ${userId}`);
        opened.set(req, { parts, cols: q.data.cols, rows: q.data.rows });
      },
    }, (socket, req) => {
      const { parts, cols, rows } = opened.get(req)!;
      const term = parts.herdrTerminal.open({ cols, rows });
      term.onData((d) => { if (socket.readyState === socket.OPEN) socket.send(d); });
      term.onExit(() => socket.close(1000, 'the terminal ended'));
      socket.on('message', (raw) => {
        let m;
        try {
          m = message.safeParse(JSON.parse(String(raw)));
        } catch {
          return;
        }
        if (!m.success) return;
        if (m.data.type === 'input') term.write(m.data.data);
        else term.resize(m.data.cols, m.data.rows);
      });
      socket.on('close', () => term.kill());
    });
  });
}
