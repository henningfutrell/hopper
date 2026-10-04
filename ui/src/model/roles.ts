// What a UI session's role lets it do (design.md "Sign-in: none, password, local, OIDC and SAML" — Roles). The
// daemon decides; this only hides what it would refuse. Each role includes the ones before it.
import type { SessionUser, UiRole } from './wire';

const RANK: readonly UiRole[] = ['viewer', 'operator', 'admin'];

export const allows = (user: SessionUser | null, needs: UiRole): boolean => user !== null && RANK.indexOf(user.role) >= RANK.indexOf(needs);
