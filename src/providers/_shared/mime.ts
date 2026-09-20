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
 * Encodes a string to standard Base64 using Web API primitives.
 */
function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
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
 * Encodes header values per RFC 2047 if non-ASCII characters are present.
 */
function encodeSubject(subject: string): string {
  if (isAsciiPrintable(subject)) {
    return subject;
  }
  return `=?UTF-8?B?${encodeBase64(subject)}?=`;
}

/**
 * Normalizes all line endings (CRLF, LF, CR) to strict CRLF (\r\n).
 */
function normalizeCrlf(str: string): string {
  return str.replaceAll(/\r\n|\r|\n/g, '\r\n');
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
    `From: ${options.from}`,
    `To: ${options.to}`,
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
      '',
      normalizeCrlf(options.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      normalizeCrlf(options.html),
      `--${boundary}--`,
    ];

    return parts.join('\r\n');
  }

  headers.push('Content-Type: text/plain; charset=utf-8');

  const parts = [headers.join('\r\n'), '', normalizeCrlf(options.text)];

  return parts.join('\r\n');
}

export default buildMimeMessage;
