/**
 * A call the store could not make (issue #1961): Postgres refused or cancelled it, or the connection or the worker gave
 * no answer. Never a fault of the data the call carried in, so a caller that tells the two apart tries again later.
 */
export class StoreError extends Error {}
