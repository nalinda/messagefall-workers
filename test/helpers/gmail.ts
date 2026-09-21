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

/**
 * Returns a MIME message's header block with folded continuation lines joined back up, as any
 * real reader does before looking at a header value. A long RFC 2047 subject spans several
 * lines, so a test that splits the raw message on CRLF would otherwise see only its first
 * encoded-word.
 */
export function unfoldHeaders(mime: string): string {
  const end = mime.indexOf('\r\n\r\n');
  const block = end === -1 ? mime : mime.slice(0, end);
  return block.replaceAll(/\r\n[\t ]+/g, ' ');
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
 *
 * The linear whitespace separating two adjacent encoded-words is dropped first, as RFC 2047
 * § 6.2 requires: a long non-ASCII subject is emitted as several encoded-words folded onto
 * continuation lines, and that folding is not part of the value.
 */
export function decodeRfc2047(header: string): string {
  return header
    .replaceAll(/\?=(?:\r\n)?[\t ]+=\?/g, '?==?')
    .replaceAll(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_, charset: string, encoding: string, text: string) =>
        decodeRfc2047Word(charset, encoding, text)
    );
}
