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

import { decodeRfc2047, loadBuildMimeMessage } from '../helpers/gmail.js';

describe('MIME message builder (Issue #20)', () => {
  it('builds a text-only MIME message with required headers and CRLF line endings', async () => {
    const buildMimeMessage = await loadBuildMimeMessage();

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

  it('builds a multipart/alternative MIME message with text before html when html is provided', async () => {
    const buildMimeMessage = await loadBuildMimeMessage();

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
    const boundaryMatch = /Content-Type:\s*multipart\/alternative;\s*boundary="?([^"\r\n]+)"?/i.exec(mime);
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

  it('encodes non-ASCII Subject headers with RFC 2047 encoded words', async () => {
    const buildMimeMessage = await loadBuildMimeMessage();

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

      const lines = mime.split('\r\n');
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

  it('leaves ASCII-only Subject unencoded without RFC 2047 wrappers', async () => {
    const buildMimeMessage = await loadBuildMimeMessage();

    const asciiSubject = 'Simple ASCII Subject 12345';
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: asciiSubject,
      text: 'Body text',
    });

    expect(mime.length).toBeGreaterThan(0);
    const lines = mime.split('\r\n');
    const subjectLine = lines.find((line) => line.startsWith('Subject:'));
    expect(subjectLine).toBeDefined();
    const subjectHeader = subjectLine!.slice('Subject:'.length).trim();

    expect(subjectHeader).toBe(asciiSubject);
    expect(subjectHeader).not.toContain('=?');
    expect(subjectHeader).not.toContain('?=');
  });

  it('formats Date header per RFC 2822', async () => {
    const buildMimeMessage = await loadBuildMimeMessage();

    const testDate = new Date('2026-09-20T16:22:45.000Z');
    const mime = buildMimeMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Date Test',
      text: 'Body',
      date: testDate,
    });

    expect(mime.length).toBeGreaterThan(0);
    const lines = mime.split('\r\n');
    const dateLine = lines.find((line) => line.startsWith('Date:'));
    expect(dateLine).toBeDefined();
    const dateHeader = dateLine!.slice('Date:'.length).trim();

    // Date must be parseable and match the specified time
    const parsedTime = Date.parse(dateHeader);
    expect(Number.isNaN(parsedTime)).toBe(false);
    expect(new Date(parsedTime).toISOString()).toBe(testDate.toISOString());
  });
});
