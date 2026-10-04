// Webhook types beside types.ts (re-exported from it).

/**
 * A UI edit of webhooks.yaml (POST /ui/api/webhooks, issue #18), against the file's `version`
 * (sha-256 of its bytes, or `missing`). `name` is the reconcile key: never changed. The hopper makes
 * and keeps no secret (issue #56): `add` names the `WEBHOOK_SECRET_*` variable the runtime gives the
 * secret in; the secret is set and rotated there.
 */
export type WebhooksEdit =
  | { action: 'add'; name: string; url: string; events: string[]; secretEnv: string; active?: boolean; version: string }
  | { action: 'edit'; name: string; url?: string; events?: string[]; active?: boolean; version: string }
  | { action: 'remove'; name: string; version: string };

/** The variables a UI session may name for a subscription's secret: never another credential of the runtime. */
export const UI_SECRET_ENV = /^WEBHOOK_SECRET_[A-Z0-9_]+$/;
