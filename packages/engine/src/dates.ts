const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar date (YYYY-MM-DD) in the device's LOCAL time zone. `toISOString()` would give the UTC date, which is
 *  yesterday for a user in Poland between 00:00 and 02:00 local time. */
export function localDateISO(offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days between two YYYY-MM-DD strings (b − a). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
