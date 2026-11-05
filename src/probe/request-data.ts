/** CDP's event-carried POST bytes survive renderer teardown; incomplete entries require the getter. */
export function inlineRequestData(request: {
  postData?: string;
  postDataEntries?: Array<{ bytes?: string }>;
}): { value: string; source: 'postData' | 'postDataEntries' } | undefined {
  if (request.postData !== undefined) return { value: request.postData, source: 'postData' };
  const entries = request.postDataEntries;
  if (entries === undefined || entries.length === 0 || entries.some((entry) => entry.bytes === undefined)) return undefined;
  const chunks: Buffer[] = [];
  for (const { bytes } of entries) {
    if (bytes === undefined) return undefined;
    const buffer = Buffer.from(bytes, 'base64');
    // Buffer silently accepts malformed base64. Never label a partial decode as complete evidence.
    if (buffer.toString('base64') !== bytes) return undefined;
    chunks.push(buffer);
  }
  try { return { value: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), source: 'postDataEntries' }; }
  catch { return undefined; }
}
