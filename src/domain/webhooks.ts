// Webhook types beside types.ts (re-exported from it).

/**
 * A UI edit of the webhook subscriptions (POST /ui/api/webhooks, issue #18): one row of the store's
 * table, the only place they are kept (issue #78). `name` is the key: never changed. The signing secret
 * is the hopper's own (issue #451): `add` takes one typed in, or the hopper makes one; `replace` stores a
 * new one typed in; `rotate` has the hopper make a new one. It is kept sealed and never answered back,
 * except a secret the hopper made, in the answer to the edit that made it.
 */
export type WebhooksEdit =
  | { action: 'add'; name: string; url: string; events: string[]; active?: boolean; secret?: string }
  | { action: 'edit'; name: string; url?: string; events?: string[]; active?: boolean }
  | { action: 'replace'; name: string; secret: string }
  | { action: 'rotate'; name: string }
  | { action: 'remove'; name: string };
