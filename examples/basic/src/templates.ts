/**
 * Example template catalogue for the basic Worker example.
 *
 * Demonstrates:
 * - `orderUpdate`: A notification template with WhatsApp-first SMS-fallback and always-on email.
 * - `loginCode`: An authentication (OTP) template with WhatsApp and SMS channels.
 *
 * Every template declares an `input` Standard Schema: the payload posted to `/send` is validated
 * against it before anything renders, and the channel renderers are typed from it.
 *
 * @module
 */

import { defineTemplates } from 'messagefall-workers';
import * as v from 'valibot';

const loginCodeInput = v.object({ code: v.pipe(v.string(), v.length(6)) });
type LoginCodeInput = v.InferOutput<typeof loginCodeInput>;

const orderUpdateInput = v.object({
  orderId: v.pipe(v.string(), v.minLength(1)),
  status: v.pipe(v.string(), v.minLength(1)),
});
type OrderUpdateInput = v.InferOutput<typeof orderUpdateInput>;

export const templates = defineTemplates({
  loginCode: {
    input: loginCodeInput,
    kind: 'otp',
    whatsapp: {
      template: 'login_code',
      language: 'en',
      params: ({ code }: LoginCodeInput) => [code],
    },
  },
  orderUpdate: {
    input: orderUpdateInput,
    kind: 'notification',
    whatsapp: {
      template: 'order_update',
      language: 'en',
      params: ({ orderId, status }: OrderUpdateInput) => [orderId, status],
    },
    sms: ({ orderId, status }: OrderUpdateInput) => `Order ${orderId} update: ${status}`,
    email: {
      subject: ({ orderId }: OrderUpdateInput) => `Order ${orderId} Update`,
      text: ({ orderId, status }: OrderUpdateInput) => `Your order ${orderId} is now ${status}.`,
    },
  },
});
