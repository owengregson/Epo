/**
 * Serialize a JavaScript value expression without literal script delimiters.
 * This encodes script source, not HTML rendered later from the decoded value.
 * Keep JSON.stringify's conversions/errors and template interpolation's undefined.
 */
export function jsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
