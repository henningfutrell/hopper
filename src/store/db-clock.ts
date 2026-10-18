// The database's clock (issue #1954, design.md "Sagas: work that survives a stop"): a lease that the hosts on one
// database race is timed on the clock they share, never on a host's own, so a host whose clock is off neither takes a
// lease another host holds nor holds one past its end. Text in the format of `Date.prototype.toISOString`, so it
// compares as text with the times the rows already hold.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The database's time now, as SQL. */
export const DB_NOW = `to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO})`;

/** The database's time a number of milliseconds from now, as SQL: the statement takes the milliseconds as its parameter there. */
export const DB_NOW_PLUS_MS = `to_char((clock_timestamp() + ?::float8 * interval '1 millisecond') AT TIME ZONE 'UTC', ${ISO})`;
