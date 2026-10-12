// The grants' events (issue #881, design.md "Grants and refresh tokens"): a grant minted, refreshed, a spent refresh token
// sent again, a grant ended, and the API-token lifetime changed. Part of EVENT_SCHEMAS (schemas.ts). Never a token.
import { z } from 'zod';
import { GRANT_END_REASONS, UI_ROLES } from '../domain/types.ts';

const strict = z.strictObject;
const grant = { grant: z.string(), label: z.string(), holder: z.string().optional() };

export const API_GRANT_EVENT_SCHEMAS = {
  'api_grant.minted': strict({
    ...grant, role: z.enum(UI_ROLES), scopes: z.array(z.string()), box: z.boolean(), endsAt: z.iso.datetime().nullable(), tokenMinutes: z.number().int(),
  }),
  'api_grant.refreshed': strict({ grant: z.string(), from: z.string() }),
  'api_grant.reuse_detected': strict({ ...grant, from: z.string() }),
  'api_grant.revoked': strict({ ...grant, reason: z.enum(GRANT_END_REASONS) }),
  'api_tokens.settings_changed': strict({ tokenMinutes: z.number().int() }),
} as const;
