/** Current time as an ISO-8601 string with timezone offset (e.g. capture time). */
export function nowIso(): string {
  return new Date().toISOString();
}
