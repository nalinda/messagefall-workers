/**
 * Tests for the MIME message builder (Issue #20).
 *
 * Acceptance criteria:
 * - Text-only MIME message: headers (From, To, Subject, MIME-Version, Date, Content-Type: text/plain; charset=UTF-8) and CRLF line endings.
 * - Multipart/alternative MIME message: text part before html part, boundaries, Content-Type headers, and CRLF line endings.
 * - Subject with non-ASCII characters (e.g. emoji, accented text, non-Latin scripts) is RFC 2047 encoded.
 * - Subject with ASCII-only characters is emitted as plain text.
 * - Date header is formatted per RFC 2822.
 */

import { describe, expect, it } from 'bun:test';

import { buildMimeMessage } from '../../../src/providers/_shared/mime.js';
import { decodeRfc2047, unfoldHeaders } from '../../helpers/gmail.js';

describe('MIME message builder (Issue #20)', () => {
  it('builds a text-only MIME message with required headers and CRLF line endings', () => {
    const date = new Date('2026-09-20T12:00:00.000Z');
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello World',
      text: 'This is a test message.\r\nLine 2.',
      date,
    });

    expect(mime).toBeDefined();
    expect(typeof mime).toBe('string');
    expect(mime.length).toBeGreaterThan(0);

    // Headers verification
    expect(mime).toContain('From: sender@example.com');
    expect(mime).toContain('To: recipient@example.com');
    expect(mime).toContain('Subject: Hello World');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toMatch(/Date:\s*[A-Za-z]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}/);
    expect(mime).toMatch(/Content-Type:\s*text\/plain;\s*charset="?utf-8"?/i);

    // Body verification
    expect(mime).toContain('This is a test message.');

    // Line endings must be CRLF (\r\n) strictly, never lone LF (\n)
    expect(mime).toContain('\r\n');
    const strippedCrLf = mime.replaceAll('\r\n', '');
    expect(strippedCrLf).not.toContain('\n');
    expect(strippedCrLf).not.toContain('\r');
  });

  it('builds a multipart/alternative MIME message with text before html when html is provided', () => {
    const date = new Date('2026-09-20T12:00:00.000Z');
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Order Confirmation',
      text: 'Plain text order summary',
      html: '<p><strong>HTML</strong> order summary</p>',
      date,
    });

    expect(mime).toBeDefined();
    expect(typeof mime).toBe('string');
    expect(mime.length).toBeGreaterThan(0);

    // Content-Type must be multipart/alternative with a boundary parameter
    const boundaryMatch =
      /Content-Type:\s*multipart\/alternative;\s*boundary="?([^"\r\n]+)"?/i.exec(mime);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1];

    // Check for boundary occurrences
    const startBoundary = `--${boundary}`;
    const endBoundary = `--${boundary}--`;

    expect(mime).toContain(startBoundary);
    expect(mime).toContain(endBoundary);

    // Ensure text part precedes html part
    const textIndex = mime.indexOf('Plain text order summary');
    const htmlIndex = mime.indexOf('<p><strong>HTML</strong> order summary</p>');

    expect(textIndex).toBeGreaterThan(0);
    expect(htmlIndex).toBeGreaterThan(0);
    expect(textIndex).toBeLessThan(htmlIndex);

    // Ensure content types of subparts are text/plain and text/html
    expect(mime).toMatch(/Content-Type:\s*text\/plain/i);
    expect(mime).toMatch(/Content-Type:\s*text\/html/i);

    // CRLF verification
    const strippedCrLf = mime.replaceAll('\r\n', '');
    expect(strippedCrLf).not.toContain('\n');
    expect(strippedCrLf).not.toContain('\r');
  });

  it('encodes non-ASCII Subject headers with RFC 2047 encoded words', () => {
    const testSubjects = [
      { raw: 'Welcome 👋 to our service!', desc: 'emoji' },
      { raw: 'Überprüfung Ihrer Bestellung #987', desc: 'German umlaut' },
      { raw: 'Café & Résumé confirmation', desc: 'French accents' },
      { raw: 'ගිණුම් තහවුරු කිරීම', desc: 'Sinhala unicode' },
    ];

    for (const { raw } of testSubjects) {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: raw,
        text: 'Body text',
      });

      expect(mime.length).toBeGreaterThan(0);

      const lines = unfoldHeaders(mime).split('\r\n');
      const subjectLine = lines.find((line) => line.startsWith('Subject:'));
      expect(subjectLine).toBeDefined();
      const subjectHeader = subjectLine!.slice('Subject:'.length).trim();

      // Header must contain RFC 2047 encoded-word format: =?charset?encoding?encoded_text?=
      expect(subjectHeader).toMatch(/=\?[a-z0-9-]+\?[bq]\?[^?]+\?=/i);

      // Decoding RFC 2047 must recover the original subject text exactly
      const decodedSubject = decodeRfc2047(subjectHeader);
      expect(decodedSubject).toBe(raw);
    }
  });

  it('leaves ASCII-only Subject unencoded without RFC 2047 wrappers', () => {
    const asciiSubject = 'Simple ASCII Subject 12345';
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: asciiSubject,
      text: 'Body text',
    });

    expect(mime.length).toBeGreaterThan(0);
    const lines = unfoldHeaders(mime).split('\r\n');
    const subjectLine = lines.find((line) => line.startsWith('Subject:'));
    expect(subjectLine).toBeDefined();
    const subjectHeader = subjectLine!.slice('Subject:'.length).trim();

    expect(subjectHeader).toBe(asciiSubject);
    expect(subjectHeader).not.toContain('=?');
    expect(subjectHeader).not.toContain('?=');
  });

  it('formats Date header per RFC 2822', () => {
    const testDate = new Date('2026-09-20T16:22:45.000Z');
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Date Test',
      text: 'Body',
      date: testDate,
    });

    expect(mime.length).toBeGreaterThan(0);
    const lines = unfoldHeaders(mime).split('\r\n');
    const dateLine = lines.find((line) => line.startsWith('Date:'));
    expect(dateLine).toBeDefined();
    const dateHeader = dateLine!.slice('Date:'.length).trim();

    // Date must be parseable and match the specified time
    const parsedTime = Date.parse(dateHeader);
    expect(Number.isNaN(parsedTime)).toBe(false);
    expect(new Date(parsedTime).toISOString()).toBe(testDate.toISOString());
  });

  describe('header injection', () => {
    // From and To are interpolated verbatim, so a line break in either would end the header
    // and let the caller append their own — a Bcc:, or a whole second body.
    it.each([
      ['To', 'victim@example.com\r\nBcc: attacker@evil.example'],
      ['To', 'victim@example.com\nBcc: attacker@evil.example'],
      ['To', 'victim@example.com\rBcc: attacker@evil.example'],
    ])('throws rather than injecting a header through %s', (_field, value) => {
      expect(() =>
        buildMimeMessage({
          from: 'sender@example.com',
          to: value,
          subject: 'Hello',
          text: 'Body',
        })
      ).toThrow(/line break/);
    });

    it('throws rather than injecting a header through From', () => {
      expect(() =>
        buildMimeMessage({
          from: 'sender@example.com\r\nBcc: attacker@evil.example',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'Body',
        })
      ).toThrow(/line break/);
    });

    it('RFC 2047-encodes a subject containing a line break instead of emitting it raw', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Hello\r\nBcc: attacker@evil.example',
        text: 'Body',
      });

      const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
      expect(headerBlock).not.toContain('Bcc:');
      expect(headerBlock).toContain('=?UTF-8?B?');
    });
  });

  describe('Content-Transfer-Encoding', () => {
    it('declares 8bit for a non-ASCII text-only body', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Verification',
        text: 'ඔබගේ සත්‍යාපන කේතය: 123456',
      });

      expect(mime).toContain('Content-Transfer-Encoding: 8bit');
      // Declared, not re-encoded: the body is still written verbatim.
      expect(mime).toContain('ඔබගේ සත්‍යාපන කේතය: 123456');
    });

    it('declares 7bit for an ASCII-only body', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Verification',
        text: 'Your code is 123456',
      });

      expect(mime).toContain('Content-Transfer-Encoding: 7bit');
      expect(mime).not.toContain('Content-Transfer-Encoding: 8bit');
    });

    it('declares the encoding per part, so an ASCII text part and a non-ASCII html part differ', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Order',
        text: 'Plain ASCII summary',
        html: '<p>ඔබගේ ඇණවුම</p>',
      });

      const textPartStart = mime.indexOf('Content-Type: text/plain');
      const htmlPartStart = mime.indexOf('Content-Type: text/html');
      const textPart = mime.slice(textPartStart, htmlPartStart);
      const htmlPart = mime.slice(htmlPartStart);

      expect(textPart).toContain('Content-Transfer-Encoding: 7bit');
      expect(htmlPart).toContain('Content-Transfer-Encoding: 8bit');
    });
  });

  describe('RFC 2047 encoded-word folding', () => {
    const longSinhalaSubject = 'ඔබගේ ගිණුම සඳහා වූ සත්‍යාපන කේතය සහ ආරක්ෂක දැනුම්දීම පිළිබඳ විස්තර';

    it('folds a long non-ASCII subject into several encoded-words, none over 75 characters', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: longSinhalaSubject,
        text: 'Body',
      });

      const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
      const words = headerBlock.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
      expect(words.length).toBeGreaterThan(1);
      for (const word of words) {
        expect(word.length).toBeLessThanOrEqual(75);
      }

      // Every line carrying one stays inside RFC 2047's 76-character header-line limit, the
      // `Subject: ` prefix included.
      const subjectLines = headerBlock
        .split('\r\n')
        .filter((line) => line.startsWith('Subject:') || line.startsWith(' =?UTF-8?B?'));
      expect(subjectLines).toHaveLength(words.length);
      for (const line of subjectLines) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
    });

    it('round-trips the folded subject back to the original text', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: longSinhalaSubject,
        text: 'Body',
      });

      const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
      const subjectHeader = headerBlock.slice(
        headerBlock.indexOf('Subject: ') + 'Subject: '.length,
        headerBlock.indexOf('\r\nDate: ')
      );
      expect(decodeRfc2047(subjectHeader)).toBe(longSinhalaSubject);
    });

    it('keeps a short non-ASCII subject in a single unfolded encoded-word', () => {
      const mime = buildMimeMessage({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Café ☕',
        text: 'Body',
      });

      const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
      const words = headerBlock.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
      expect(words).toHaveLength(1);
      expect(decodeRfc2047(words[0] ?? '')).toBe('Café ☕');
    });
  });
});
