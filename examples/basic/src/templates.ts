/**
 * Example template catalogue for the basic Worker example.
 *
 * Demonstrates:
 * - `orderUpdate`: A notification template with WhatsApp-first SMS-fallback and always-on email.
 * - `loginCode`: An authentication (OTP) template with WhatsApp and SMS channels.
 *
 * @module
 */

import { defineTemplates } from 'messagefall-workers';

export const templates = defineTemplates({
  loginCode: {
    kind: 'otp',
    whatsapp: {
      template: 'login_code',
      language: 'en',
      params: ({ code }: { code: string }) => [code],
    },
  },
  orderUpdate: {
    kind: 'notification',
    whatsapp: {
      template: 'order_update',
      language: 'en',
      params: ({ orderId, status }: { orderId: string; status: string }) => [orderId, status],
    },
    sms: ({ orderId, status }: { orderId: string; status: string }) =>
      `Order ${orderId} update: ${status}`,
    email: {
      subject: ({ orderId }: { orderId: string; status: string }) => `Order ${orderId} Update`,
      text: ({ orderId, status }: { orderId: string; status: string }) =>
        `Your order ${orderId} is now ${status}.`,
    },
  },
});
