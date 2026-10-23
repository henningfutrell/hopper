// Wall-clock time in an IANA time zone, by Intl alone (Node 24 has no Temporal). Pure.

/** The wall clock in `tz` at `utcMs`, as if it were UTC, minus `utcMs`: the zone's offset. Throws on an unknown zone. */
export function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** A wall-clock time in `tz` as epoch ms (twice round, so a DST edge lands right). The month is 0-based, as Date's. */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}
