// A user schema's name and SQL identifiers (issue #158), beside tenant-migrations.ts (re-exported from it) for its size.

/** `"name"`, quotes doubled: an identifier safe in SQL. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A user's schema: `u_<id>` beside the `public` instance schema, else `<instance schema>_u_<id>`. */
export const userSchemaName = (instanceSchema: string, userId: string): string => (instanceSchema === 'public' ? `u_${userId}` : `${instanceSchema}_u_${userId}`);
