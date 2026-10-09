// A double of OpenFGA at the AuthorizationServer seam (issue #559): stores, models and tuples in memory, and a check
// that evaluates the authorization model's JSON as OpenFGA does for the rewrites a model uses here (direct, computed
// userset, tuple to userset, union, intersection, difference), contextual tuples included. `reachable = false` makes
// every call fail as a refused connection; `refuseModels` makes a model write fail as OpenFGA's validation does.
import { randomUUID } from 'node:crypto';
import type { AuthorizationServer, RelationshipTuple } from '../../src/domain/ports.ts';
import { authorizationServerRefusal } from '../../src/domain/ports.ts';

type Userset = {
  this?: object;
  computedUserset?: { relation: string };
  tupleToUserset?: { tupleset: { relation: string }; computedUserset: { relation: string } };
  union?: { child: Userset[] };
  intersection?: { child: Userset[] };
  difference?: { base: Userset; subtract: Userset };
};
interface Model { type_definitions: { type: string; relations?: Record<string, Userset> }[] }
interface Store { name: string; models: Map<string, Model>; tuples: Map<string, RelationshipTuple> }

export interface FakeAuthorizationServer extends AuthorizationServer {
  reachable: boolean;
  refuseModels: string | undefined;
  readonly stores: Map<string, Store>;
  /** Every check asked, in order. */
  readonly checks: { tuple: RelationshipTuple; contextual: RelationshipTuple[]; modelId: string }[];
  /** Write a tuple behind the hopper's back, or delete one (drift). */
  storeTuples(storeId: string): Map<string, RelationshipTuple>;
}

const key = (t: RelationshipTuple) => `${t.subject} ${t.relation} ${t.object}`;
const typeOf = (object: string) => object.slice(0, object.indexOf(':'));

export function createFakeAuthorizationServer(): FakeAuthorizationServer {
  const stores = new Map<string, Store>();
  const checks: FakeAuthorizationServer['checks'] = [];
  let n = 0;
  const fake: FakeAuthorizationServer = {
    reachable: true,
    refuseModels: undefined,
    stores,
    checks,
    storeTuples: (id) => stores.get(id)!.tuples,
    async store(id, name) {
      reach();
      if (id !== undefined && stores.has(id)) return id;
      const created = `store-${randomUUID()}`;
      stores.set(created, { name, models: new Map(), tuples: new Map() });
      return created;
    },
    async writeModel(storeId, model) {
      reach();
      if (fake.refuseModels) throw authorizationServerRefusal(fake.refuseModels);
      const id = `model-${++n}`;
      the(storeId).models.set(id, model as Model);
      return id;
    },
    async tuples(storeId) {
      reach();
      return [...the(storeId).tuples.values()];
    },
    async write(storeId, _modelId, { writes, deletes }) {
      reach();
      const s = the(storeId);
      for (const t of deletes) {
        if (!s.tuples.delete(key(t))) throw authorizationServerRefusal(`cannot delete a tuple which does not exist: ${key(t)}`);
      }
      for (const t of writes) {
        if (s.tuples.has(key(t))) throw authorizationServerRefusal(`cannot write a tuple which already exists: ${key(t)}`);
        s.tuples.set(key(t), t);
      }
    },
    async check(storeId, modelId, tuple, contextual) {
      reach();
      checks.push({ tuple, contextual, modelId });
      const s = the(storeId);
      const model = s.models.get(modelId);
      if (!model) throw authorizationServerRefusal(`authorization model ${modelId} not found`);
      const all = [...s.tuples.values(), ...contextual];
      const rewrite = (object: string, relation: string): Userset | undefined =>
        model.type_definitions.find((t) => t.type === typeOf(object))?.relations?.[relation];
      const has = (user: string, relation: string, object: string, depth: number): boolean => {
        if (depth > 25) return false;
        const us = rewrite(object, relation);
        return us !== undefined && evaluate(us, user, relation, object, depth + 1);
      };
      const evaluate = (us: Userset, user: string, relation: string, object: string, depth: number): boolean => {
        if (us.this) return all.some((t) => t.subject === user && t.relation === relation && t.object === object);
        if (us.computedUserset) return has(user, us.computedUserset.relation, object, depth);
        if (us.tupleToUserset) {
          const { tupleset, computedUserset } = us.tupleToUserset;
          return all.filter((t) => t.relation === tupleset.relation && t.object === object)
            .some((t) => has(user, computedUserset.relation, t.subject, depth));
        }
        if (us.union) return us.union.child.some((c) => evaluate(c, user, relation, object, depth));
        if (us.intersection) return us.intersection.child.every((c) => evaluate(c, user, relation, object, depth));
        if (us.difference) return evaluate(us.difference.base, user, relation, object, depth) && !evaluate(us.difference.subtract, user, relation, object, depth);
        return false;
      };
      return has(tuple.subject, tuple.relation, tuple.object, 0);
    },
  };
  function reach(): void {
    if (!fake.reachable) throw new Error('connect ECONNREFUSED openfga:8080');
  }
  function the(id: string): Store {
    const s = stores.get(id);
    if (!s) throw authorizationServerRefusal(`store ${id} not found`);
    return s;
  }
  return fake;
}
