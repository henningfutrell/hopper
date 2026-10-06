// Realms managed from Settings → Sign-in (issue #185, design.md "Sign-in: realms"): GET /api/realms
// reads auth.yaml's realms (an instance read: an admin session, or loopback without one), and
// `realmsAdmin.edit` behind POST /ui/api/realms (src/http/ui/) makes one change. A change is loaded
// with its secrets before it is stored — a document that would not load is refused, naming the field —
// then written against the version read, applied to sign-in at once, and applied to the stored
// sessions as a start would. A change that would leave the acting session without admin is refused:
// nobody locks themselves out from the UI.
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import { AUTH, AuthEditError, editAuthDocument, loadAuthDocument, realmsView, type SignIn } from '../auth/index.ts';
import { roleIn } from '../auth/index.ts';
import type { ConfigDocuments, InstanceDocumentName } from '../domain/store.ts';
import { roleAllows, type Identity, type RealmsEdit, type RealmsView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import type { UiSessions } from './ui/sessions.ts';

export interface RealmsAdmin {
  view(): RealmsView;
  /** Make `edit` as `actor`; throws HttpError (400 invalid, 404 no such realm, 409 moved or a lockout). */
  edit(edit: RealmsEdit, actor: Identity): RealmsView;
}

export function createRealmsAdmin(o: {
  documents: ConfigDocuments<InstanceDocumentName>; secret: (name: string) => string | undefined; signIn: SignIn; sessions: UiSessions;
}): RealmsAdmin {
  const view = (): RealmsView => {
    const origin = o.signIn.origin();
    const v = realmsView(o.documents.read(AUTH));
    return {
      version: o.documents.version(AUTH), local: v.local, none: v.none, origin,
      realms: v.realms.map((r) => {
        if (r.type === 'password' || r.type === 'ldap') return r;
        const urls = { callback: `${origin}/ui/auth/${r.name}/callback` };
        return r.type === 'saml' ? { ...r, ...urls, metadata: `${origin}/ui/auth/${r.name}/metadata` } : { ...r, ...urls };
      }),
    };
  };
  return {
    view,
    edit({ version, ...edit }, actor) {
      const before = o.documents.read(AUTH);
      if (version !== o.documents.version(AUTH)) throw new HttpError(409, 'auth.yaml changed since it was read: reload and make the change again');
      let text: string;
      try {
        text = editAuthDocument(before, edit);
      } catch (e) {
        if (e instanceof AuthEditError) throw new HttpError(e.status, e.message);
        throw e;
      }
      let config;
      try {
        config = loadAuthDocument(text, o.secret);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const role = roleIn(config, actor);
      if (role === null || !roleAllows(role, 'admin')) {
        throw new HttpError(409, `this change would end your own admin session (${actor.realm}): sign in as an admin another way first, or change it with hopper config edit auth.yaml`);
      }
      if (!o.documents.write(AUTH, text, version)) throw new HttpError(409, 'auth.yaml changed since it was read: reload and make the change again');
      o.signIn.apply(config);
      const r = o.sessions.reconcile(o.signIn.roleOf);
      const what = 'name' in edit ? `${edit.action} ${edit.name}` : edit.action === 'save' ? `add ${String((parse(edit.entry) as { name?: unknown } | null)?.name)}` : edit.action;
      console.warn(`hopper: auth.yaml changed in the UI by ${actor.realm} ${actor.subject} (${what}): applied; ${r.dropped} session(s) ended, ${r.changed} changed role`);
      return view();
    },
  };
}

export function realmRoutes(app: FastifyInstance, o: { realms: RealmsAdmin; sessions: UiSessions }): void {
  app.get('/api/realms', async (req): Promise<RealmsView> => {
    const s = o.sessions.find(sessionToken(req));
    if (s && !roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not read the realms; it needs admin`);
    return o.realms.view();
  });
}
