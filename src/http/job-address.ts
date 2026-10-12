// The address path (issue #698, src/machines/hopper-address.ts): an ssh target's probe asks it at each of the hopper's
// addresses, from the machine, to learn which one its jobs reach the hopper at. Behind the Host guard like every
// route, so an address the guard refuses is not one a job could use.
//
//   GET /job/address   204, nothing in it. No token; it changes nothing and records nothing.
import type { FastifyInstance } from 'fastify';
import { ADDRESS_PATH } from '../machines/hopper-address.ts';

export function jobAddressRoutes(app: FastifyInstance): void {
  app.get(ADDRESS_PATH, async (_req, reply) => reply.code(204).send());
}
