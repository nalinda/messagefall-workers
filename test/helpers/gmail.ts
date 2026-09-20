/**
 * Test helpers for Gmail provider specifications (Issue #20).
 *
 * The provider factory, its config type and buildMimeMessage are imported
 * directly from src/ by the tests; only the decoding helpers live here.
 *
 * @module
 */

/**
 * Decodes base64url string to UTF-8 text using Web standard APIs.
 */
export function decodeBase64Url(base64Url: string): string {
  let base64 = base64Url.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

function decodeRfc2047Word(_charset: string, encoding: string, text: string): string {
  const enc = encoding.toUpperCase();
  if (enc === 'B') {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
  }
  if (enc === 'Q') {
    return text
      .replaceAll('_', ' ')
      .replaceAll(/=([a-f0-9]{2})/gi, (_match: string, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      );
  }
  return text;
}

/**
 * Decodes RFC 2047 encoded header fields (e.g. "=?UTF-8?B?...?=").
 */
export function decodeRfc2047(header: string): string {
  return header.replaceAll(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset: string, encoding: string, text: string) =>
    decodeRfc2047Word(charset, encoding, text)
  );
}
