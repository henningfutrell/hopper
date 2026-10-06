// The saml realm: SAML 2.0 single sign-on (Entra ID, Okta, Keycloak, ADFS, …) through @node-saml/node-saml:
// SP-initiated only (HTTP-Redirect AuthnRequest, HTTP-POST response to the assertion consumer
// service). Assertions must be signed by the configured certificate, answer a request this
// daemon sent (InResponseTo, kept in memory), and name this service as audience.
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import type { Identity } from '../domain/types.ts';
import type { SamlRealmConfig } from './config.ts';
import { stringList, stringOf, type RedirectRealm } from './realm.ts';

export function createSamlRealm(c: SamlRealmConfig, acsUrl: string, entityId: string): RedirectRealm {
  const saml = new SAML({
    entryPoint: c.entryPoint, idpCert: c.idpCert, issuer: entityId, callbackUrl: acsUrl, audience: entityId,
    ...(c.idpIssuer ? { idpIssuer: c.idpIssuer } : {}),
    wantAssertionsSigned: true, wantAuthnResponseSigned: c.requireSignedResponse,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: 10 * 60_000,
    // Let the IdP choose the NameID format and the authentication method (MFA, passwordless).
    identifierFormat: null, disableRequestedAuthnContext: true,
  });
  const attr = (p: Profile, name: string | undefined): unknown => (name === undefined ? undefined : (p as Record<string, unknown>)[name]);
  return {
    name: c.name, label: c.label, type: 'saml',
    async start(flowId) {
      return { url: await saml.getAuthorizeUrlAsync(flowId, undefined, {}), secrets: {} };
    },
    flowIdOf: (cb) => stringOf(cb.body?.RelayState),
    async finish(cb) {
      const { profile } = await saml.validatePostResponseAsync(cb.body ?? {});
      if (!profile?.nameID) throw new Error('SAML response has no NameID');
      const who: Identity = { realm: c.name, subject: profile.nameID, username: stringOf(attr(profile, c.attributes.username)) ?? profile.nameID, groups: stringList(attr(profile, c.attributes.groups)) };
      const email = stringOf(attr(profile, c.attributes.email)) ?? stringOf(profile.email) ?? stringOf(profile.mail);
      const name = stringOf(attr(profile, c.attributes.name));
      return { ...who, ...(email ? { email } : {}), ...(name ? { name } : {}) };
    },
    metadata: () => saml.generateServiceProviderMetadata(null, null),
  };
}
