// Webhook types beside types.ts (re-exported from it).

/**
 * A UI edit of webhooks.yaml (POST /ui/api/webhooks, issue #18), against the file's `version`
 * (sha-256 of its bytes, or `missing`). `name` is the reconcile key: never changed. The daemon
 * makes every secret; `add` and `rotate-secret` answer it once.
 */
export type WebhooksEdit =
  | { action: 'add'; name: string; url: string; events: string[]; active?: boolean; version: string }
  | { action: 'edit'; name: string; url?: string; events?: string[]; active?: boolean; version: string }
  | { action: 'rotate-secret'; name: string; version: string }
  | { action: 'remove'; name: string; version: string };
