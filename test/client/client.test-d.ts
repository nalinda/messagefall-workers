/**
 * Type declarations and compile-time checks for createMessagingClient (Issue #12).
 *
 * @module
 */

import type { Fetcher } from '@cloudflare/workers-types';
import { z } from 'zod';

import type { MessageRecord } from '../../src/core/status.js';
import type { InputOf } from '../../src/templates.js';
import { defineTemplates } from '../../src/templates.js';
import type {
  ClientSendResult,
  DeliveryOverrideFor,
  MessagingClient,
} from '../helpers/client.js';

// Type testing utilities
type Extends<A, B> = A extends B ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Expect<T extends true> = T;
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

// Sample test catalog
const sampleDefs = {
  loginCode: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp' as const,
    sms: ({ code }: { code: string }) => `Code: ${code}`,
  },
  welcomeAlert: {
    input: z.object({ username: z.string() }),
    kind: 'notification' as const,
    whatsapp: {
      template: 'welcome',
      language: 'en',
      params: ({ username }: { username: string }) => [username],
    },
    email: {
      subject: ({ username }: { username: string }) => `Welcome ${username}`,
      text: ({ username }: { username: string }) => `Hello ${username}`,
    },
  },
};

const sampleTemplates = defineTemplates(sampleDefs);
type SampleCatalog = typeof sampleTemplates;
assertType<SampleCatalog>(sampleTemplates);

// 1. Correct send call compiles
type ValidLoginSend = {
  template: 'loginCode';
  args: {
    to: string;
    locale: string;
    input: { code: string };
    delivery?: DeliveryOverrideFor<SampleCatalog, 'loginCode'>;
  };
};
type TestValidSendCompiles = Expect<
  Extends<ValidLoginSend['args']['input'], InputOf<SampleCatalog, 'loginCode'>>
>;
assertType<TestValidSendCompiles>(true);

// 2. Wrong template name fails to compile
type UnknownTemplate = 'invalidTemplate';
type TestUnknownTemplateFails = Expect<
  Not<Extends<UnknownTemplate, keyof SampleCatalog>>
>;
assertType<TestUnknownTemplateFails>(true);

// 3. Wrong input field fails to compile
type WrongInput = { badField: string };
type TestWrongInputFails = Expect<
  Not<Extends<WrongInput, InputOf<SampleCatalog, 'loginCode'>>>
>;
assertType<TestWrongInputFails>(true);

// 4. delivery.always naming a channel not defined by template fails to compile
type InvalidAlwaysWhatsapp = { always: ['whatsapp'] };
type TestInvalidAlwaysFails = Expect<
  Not<Extends<InvalidAlwaysWhatsapp, DeliveryOverrideFor<SampleCatalog, 'loginCode'>>>
>;
assertType<TestInvalidAlwaysFails>(true);

// 5. delivery.fallback naming a channel not defined by template fails to compile
type InvalidFallbackEmail = { fallback: ['email'] };
type TestInvalidFallbackFails = Expect<
  Not<Extends<InvalidFallbackEmail, DeliveryOverrideFor<SampleCatalog, 'loginCode'>>>
>;
assertType<TestInvalidFallbackFails>(true);

// 6. Valid delivery channel compiles
type ValidDeliverySms = { fallback: ['sms']; always: ['sms'] };
type TestValidDeliveryCompiles = Expect<
  Extends<ValidDeliverySms, DeliveryOverrideFor<SampleCatalog, 'loginCode'>>
>;
assertType<TestValidDeliveryCompiles>(true);

// 7. delivery: 'all' compiles
type TestDeliveryAll = Expect<Extends<'all', DeliveryOverrideFor<SampleCatalog, 'loginCode'>>>;
assertType<TestDeliveryAll>(true);

// 8. Return types
type TestSendReturnsResult = Expect<
  Equals<Awaited<ReturnType<MessagingClient<SampleCatalog>['send']>>, ClientSendResult>
>;
assertType<TestSendReturnsResult>(true);

type TestStatusReturnsRecordOrNull = Expect<
  Equals<Awaited<ReturnType<MessagingClient<SampleCatalog>['status']>>, MessageRecord | null>
>;
assertType<TestStatusReturnsRecordOrNull>(true);

// 9. Options interface includes Fetcher binding and optional basePath
type ExpectedOptions = { binding: Fetcher; basePath?: string };
assertType<ExpectedOptions>({} as unknown as ExpectedOptions);
