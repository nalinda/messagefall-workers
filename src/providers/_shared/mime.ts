/**
 * MIME message builder for email providers.
 *
 * Implements RFC 2822 message format and RFC 2047 encoded-word syntax
 * for non-ASCII header values using Web standards only.
 *
 * @module
 */

/**
 * Options for constructing a MIME email message.
 */
export interface MimeMessageOptions {
  /**
   * Sender email address.
   */
  from: string;
  /**
   * Recipient email address.
   */
  to: string;
  /**
   * Subject line of the email.
   */
  subject: string;
  /**
   * Plain text email body.
   */
  text: string;
  /**
   * Optional HTML email body.
   */
  html?: string;
  /**
   * Optional message origination date (defaults to current date).
   */
  date?: Date;
}

/**
 * Encodes a string to Base64 using Web API primitives, standard alphabet by default.
 *
 * Pass `{ urlSafe: true }` for Base64URL without padding (`+`/`/` swapped for `-`/`_`, `=`
 * stripped) — the encoding Gmail's API expects for a raw MIME message.
 */
export function encodeBase64(str: string, opts?: { urlSafe?: boolean }): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const standard = btoa(binary);
  return opts?.urlSafe
    ? standard.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    : standard;
}

/**
 * Returns true if all characters in the string are ASCII printable (0x20 to 0x7E).
 */
function isAsciiPrintable(str: string): boolean {
  for (const char of str) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * The UTF-8 byte budget for one encoded-word's payload.
 *
 * RFC 2047 caps an encoded-word at 75 characters and a header line carrying them at 76. The
 * `=?UTF-8?B?` … `?=` wrapper costs 12, and `Subject: ` costs another 9 on the first line, which
 * leaves 55 characters of Base64 — 13 whole quads, so 39 source bytes. Continuation lines carry
 * only a leading space and are comfortably inside the same budget at that size.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 39;

/**
 * Splits a string into runs of at most {@link ENCODED_WORD_PAYLOAD_BYTES} UTF-8 bytes, never
 * cutting a character in half. RFC 2047 requires each encoded-word to be independently
 * decodable, so a multi-byte character straddling two words would be a malformed header.
 */
function chunkByUtf8Bytes(value: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // Iterating the string yields whole code points, so surrogate pairs stay together too.
  for (const char of value) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes > 0 && currentBytes + charBytes > ENCODED_WORD_PAYLOAD_BYTES) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Encodes header values per RFC 2047 if non-ASCII characters are present.
 *
 * A long non-ASCII subject is emitted as several encoded-words folded onto continuation lines
 * rather than one oversized one: a single unfolded word would breach RFC 2047's 75-character
 * limit, which strict receivers may reject or pass through undecoded. Decoders discard the
 * linear whitespace between adjacent encoded-words, so the subject reassembles exactly.
 */
function encodeSubject(subject: string): string {
  if (isAsciiPrintable(subject)) {
    return subject;
  }
  return chunkByUtf8Bytes(subject)
    .map((chunk) => `=?UTF-8?B?${encodeBase64(chunk)}?=`)
    .join('\r\n ');
}

/**
 * Guards an unencoded header value against header injection.
 *
 * `From:` and `To:` are interpolated into the header block verbatim, so a CR or LF in either
 * ends the header and lets the caller append arbitrary ones — a `Bcc:`, or a second body. The
 * send pipeline rejects such an address long before it reaches here (`isEmailAddress` in
 * `core/send.ts`); this is the last line of defence for a provider built directly against this
 * builder. It throws rather than silently stripping: a message addressed to something other
 * than what the caller asked for is worse than no message.
 *
 * `Subject:` needs no guard — {@link encodeSubject} RFC 2047-encodes anything that is not
 * ASCII-printable, and CR and LF are not.
 */
function assertNoHeaderBreak(name: string, value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error(`mime: the ${name} header value must not contain a line break`);
  }
  return value;
}

/**
 * Normalizes all line endings (CRLF, LF, CR) to strict CRLF (\r\n).
 */
function normalizeCrlf(str: string): string {
  return str.replaceAll(/\r\n|\r|\n/g, '\r\n');
}

/**
 * The `Content-Transfer-Encoding` that honestly describes a body written into the message
 * verbatim, as this builder writes them: `8bit` once any character needs more than one UTF-8
 * byte, `7bit` otherwise. Declaring it matters — a `charset=utf-8` part with no encoding header
 * defaults to `7bit`, so a Sinhala or emoji body would be an undeclared 8-bit message, which a
 * strict relay may reject or mangle.
 */
function transferEncoding(body: string): '7bit' | '8bit' {
  return isAscii(body) ? '7bit' : '8bit';
}

/**
 * Whether every character is ASCII (0x00–0x7F). Unlike {@link isAsciiPrintable} this admits CR,
 * LF and tab, which are ordinary content in a body.
 */
function isAscii(str: string): boolean {
  for (const char of str) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Builds an RFC 2822 / MIME compliant email message string.
 *
 * Supports text/plain and multipart/alternative (text followed by html)
 * with strict CRLF line endings and UTF-8 charset.
 *
 * @param options - Email message fields.
 * @returns MIME formatted email string.
 */
export function buildMimeMessage(options: MimeMessageOptions): string {
  const date = options.date ?? new Date();
  const dateStr = date.toUTCString();
  const subjectStr = encodeSubject(options.subject);

  const headers = [
    `From: ${assertNoHeaderBreak('From', options.from)}`,
    `To: ${assertNoHeaderBreak('To', options.to)}`,
    `Subject: ${subjectStr}`,
    `Date: ${dateStr}`,
    'MIME-Version: 1.0',
  ];

  if (typeof options.html === 'string' && options.html.length > 0) {
    const boundary = `----=_Part_${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    const parts = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Transfer-Encoding: ${transferEncoding(options.text)}`,
      '',
      normalizeCrlf(options.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      `Content-Transfer-Encoding: ${transferEncoding(options.html)}`,
      '',
      normalizeCrlf(options.html),
      `--${boundary}--`,
    ];

    return parts.join('\r\n');
  }

  headers.push(
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${transferEncoding(options.text)}`
  );

  const parts = [headers.join('\r\n'), '', normalizeCrlf(options.text)];

  return parts.join('\r\n');
}

export default buildMimeMessage;
