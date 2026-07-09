/** Generates a v4 UUID. Available in all evergreen browsers and secure contexts. */
export function newId(): string {
  return crypto.randomUUID();
}
