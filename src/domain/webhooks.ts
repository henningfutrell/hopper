// Webhook types beside types.ts (re-exported from it).

/**
 * A UI edit of the webhook subscriptions (POST /ui/api/webhooks, issue #18): one row of the store's
 * table, the only place they are kept (issue #78). `name` is the key: never changed. The hopper makes
 * and keeps no secret (issue #56): `add` names the `WEBHOOK_SECRET_*` variable the runtime gives the
 * secret in; the secret is set and rotated there.
 */
export type WebhooksEdit =
  | { action: 'add'; name: string; url: string; events: string[]; secretEnv: string; active?: boolean }
  | { action: 'edit'; name: string; url?: string; events?: string[]; active?: boolean }
  | { action: 'remove'; name: string };

/** The variables a UI session may name for a subscription's secret: never another credential of the runtime. */
export const UI_SECRET_ENV = /^WEBHOOK_SECRET_[A-Z0-9_]+$/;
