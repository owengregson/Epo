/** Compare parsed HTTP(S) origins, never text elsewhere in the URL. */
export function hasWebOrigin(value: string, expectedUrl: string): boolean {
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(value);
    return (expected.protocol === 'https:' || expected.protocol === 'http:')
      && actual.protocol === expected.protocol && actual.origin === expected.origin;
  } catch {
    return false;
  }
}
