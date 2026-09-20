/**
 * Template catalogue and status-webhook parser shared by the FallbackTimer specs (Issue #8):
 * the in-process helper (`test/helpers/timer.ts`) and the workerd fixture (`timer-worker.ts`).
 *
 * Kept free of `bun:*` imports so it can be bundled into the Worker the workerd suite runs.
 *
 * @module
 */

import type { StatusEvent } from '../../../src/providers/types.js';
import { defineTemplates } from '../../../src/templates.js';

/**
 * Template catalogue for the timer specs: an OTP template (whatsapp → sms) and a notification.
 */
export const timerTemplates = defineTemplates({
  loginCode: {
    kind: 'otp',
    whatsapp: {
      template: 'auth_code',
      language: 'en',
      params: (input: { code: string }) => [input.code],
    },
    sms: (input: { code: string }) => `Your code is ${input.code}`,
  },
  reminder: {
    kind: 'notification',
    whatsapp: { text: (input: { text: string }) => `Reminder: ${input.text}` },
    sms: (input: { text: string }) => `Reminder: ${input.text}`,
  },
});

type StatusBody = { providerId: string; status: StatusEvent['status']; error?: string };

/**
 * Parses the unsigned JSON status webhook the timer specs post: one `{ providerId, status,
 * error? }` object or an array of them, stamped with the current time.
 *
 * @param request - The webhook request.
 * @returns The status events.
 */
export async function parseStatusEvents(request: Request): Promise<StatusEvent[]> {
  const body = (await request.json()) as StatusBody | StatusBody[];
  const at = new Date().toISOString();
  return (Array.isArray(body) ? body : [body]).map((event) => ({ ...event, at }));
}
