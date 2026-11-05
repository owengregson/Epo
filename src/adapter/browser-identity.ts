/**
 * Keep Chromium's native OS and browser version, removing only shell product
 * tokens. A random UA would disagree with the TLS stack, platform and native
 * UA Client Hints. This identity changes with a runtime upgrade, never per
 * request, navigation or login. No navigator/canvas/WebGL/locale spoofing.
 */
export function browserUserAgent(nativeUserAgent: string): string {
  const match = /^(Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[^ ]+ \(KHTML, like Gecko\)) .*?\b(Chrome\/[^ ]+) .*?\b(Safari\/[^ ]+)(?: .*)?$/.exec(nativeUserAgent);
  if (!match) throw new Error('Cannot derive browser identity from the native Chromium user agent');
  return `${match[1]} ${match[2]} ${match[3]}`;
}
