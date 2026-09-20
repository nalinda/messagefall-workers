/**
 * messagefall-workers
 *
 * Outbound messaging for Cloudflare Workers.
 *
 * @module
 */

import type {
  StandardSchema,
  ZodRawShape,
  ZodTypeAny,
} from 'zod';

/**
 * Channel type.
 */
export type Channel = 'whatsapp' | 'sms' | 'email';

/**
 * Delivery status.
 */
export type DeliveryStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'undelivered'
  | 'undecipherable'
  | 'unknown';

/**
 * Template kind.
 */
export type TemplateKind = 'otp' | 'text';

/**
 * Message type.
 */
export type MessageType = TemplateKind;

/**
 * Template rendering per channel.
 */
export interface TemplateRendering {
  channel: Channel;
  options: Record<string, string>;
  name?: string;
  params?: Record<string, unknown>;
}

/**
 * Template definition.
 */
export interface TemplateDefinition {
  id: string;
  kind: TemplateKind;
  inputSchema: StandardSchema<ZodRawShape>;
  renderings: TemplateRendering[];
  deliveryPolicy?: DeliveryPolicy;
}

/**
 * Delivery policy.
 */
export interface DeliveryPolicy {
  fallbackChain?: boolean;
  alwaysOnChannels?: Channel[];
  fallbacks?: {
    from: Channel;
    to: Channel;
    timeoutMs: number;
    thresholdStatuses?: DeliveryStatus[];
  }[];
}

/**
 * Send options.
 */
export interface SendOptions {
  channel: Channel | 'all';
  input: unknown;
  policy?: DeliveryPolicy;
  skipConfirmation?: boolean;
}

/**
 * Message class.
 */
export class Message<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly template: TemplateDefinition;
  private readonly input: T;
  private readonly kind: TemplateKind;
  private readonly policy: DeliveryPolicy;

  constructor(
    templateId: string,
    input: T,
    policy: DeliveryPolicy = {},
  ) {
    const registryEntry = findTemplate(templateId);
    if (!registryEntry) {
      throw new Error(`Unknown template: ${templateId}`);
    }

    this.template = registryEntry;
    this.input = validateInput(input);
    this.kind = registryEntry.kind;
    this.policy = policy;
  }

  /**
   * Get template kind.
   */
  getKind(): TemplateKind {
    return this.kind;
  }

  /**
   * Render for a specific channel.
   */
  render(channel: Channel): string {
    const rendering = findRendering(this.template, channel);
    if (!rendering) {
      throw new Error(`No rendering defined for channel: ${channel}`);
    }
    return renderText(rendering, this.input);
  }

  /**
   * Render for all configured channels.
   */
  renderAll(channels: Channel[]): Record<Channel, string> {
    const result: Record<Channel, string> = {};
    for (const channel of channels) {
      result[channel] = this.render(channel);
    }
    return result;
  }

  /**
   * Get policy.
   */
  getPolicy(): DeliveryPolicy {
    return this.policy;
  }
}

/**
 * Render a text template.
 */
function renderText(
  rendering: TemplateRendering,
  input: Record<string, unknown>,
): string {
  const text = rendering.options.text;
  return interpolateText(text, input);
}

/**
 * Interpolate text with template variables.
 */
function interpolateText(text: string, input: Record<string, unknown>): string {
  return text.replace(/:(\w+)/g, (match, key) => {
    if (input[key] !== undefined) {
      return String(input[key]);
    }
    return match;
  });
}

/**
 * Find a template in the registry.
 */
function findTemplate(id: string): TemplateDefinition | undefined {
  const registry = getRegistry();
  return registry[id];
}

/**
 * Get template rendering for a channel.
 */
function findRendering(template: TemplateDefinition, channel: Channel): TemplateRendering | undefined {
  return template.renderings.find((r) => r.channel === channel);
}

/**
 * Validate input against template schema.
 */
function validateInput(input: unknown): Record<string, unknown> {
  // TODO: Integrate with Zod StandardSchema
  // const validate = template.inputSchema;
  // const result = validate.parse(input);
  // return result;
  return input as Record<string, unknown>;
}

/**
 * Get template registry (stub for now).
 */
function getRegistry(): Map<string, TemplateDefinition> {
  return new Map();
}

/**
 * Supported channels.
 */
export const CHANNELS = ['whatsapp', 'sms', 'email'] as const;

/**
 * Delivery policy interface.
 */
export interface DeliveryPolicy {
  fallbackChain?: boolean;
  alwaysOnChannels?: Channel[];
  fallbacks?: {
    from: Channel;
    to: Channel;
    timeoutMs: number;
    thresholdStatuses?: DeliveryStatus[];
  }[];
}

/**
 * Default delivery policy.
 */
export const defaultDeliveryPolicy: DeliveryPolicy = {
  fallbackChain: true,
  alwaysOnChannels: [],
  fallbacks: [
    { from: 'whatsapp', to: 'sms', timeoutMs: 5000, thresholdStatuses: ['failed', 'undelivered'] },
  ],
};

/**
 * Message status.
 */
export interface MessageStatus {
  status: DeliveryStatus;
  timestamp: Date;
  provider?: string;
  details?: Record<string, unknown>;
}

/**
 * Provider interface.
 */
export interface Provider {
  readonly id: string;
  readonly channel: Channel;
  send(options: {
    config: unknown;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }>;
  status?(messageId: string): Promise<MessageStatus>;
  statusHandler?(request: Request): Response;
}

/**
 * Provider factory interface.
 */
export interface ProviderFactory {
  id: string;
  create(config: { state: any; channel: string }): Provider;
}

/**
 * Messaging config.
 */
export interface MessagingConfig {
  kv: KVNamespace;
  durable?: {
    class: any;
    id: string | number;
  };
  fallbackTimeoutMs?: number;
  deliveryPolicy?: DeliveryPolicy;
  providers: {
    id: string;
    config: unknown;
    state: any;
  }[];
}

/**
 * Core messaging instance.
 */
export function createMessaging(config: MessagingConfig): MessagingState {
  const state = {
    templates: new Map(),
    queue: new Map(),
    store: new Map(),
    providers: new Map(),
    policy: config.deliveryPolicy ?? defaultDeliveryPolicy,
    fallbackTimeout: config.fallbackTimeoutMs ?? 5000,
    ctx: undefined,
  };

  // Register templates (stub)
  // TODO: Load from database or KV

  // Register providers
  for (const { id, config: providerConfig } of config.providers) {
    const factory = getFactory(id);
    if (factory) {
      state.providers.set(id, factory.create({ state, channel: id }));
    }
  }

  return state;
}

/**
 * Get provider factory.
 */
function getFactory(id: string): ProviderFactory | undefined {
  const registry = getFactoryRegistry();
  return registry[id];
}

/**
 * Get provider by ID.
 */
export function getProvider(id: string, state: MessagingState): Provider | null {
  const factory = getFactory(id);
  if (!factory) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return factory.create({ state, channel: id });
}

/**
 * Factory registry (stub).
 */
function getFactoryRegistry(): Map<string, ProviderFactory> {
  return new Map([
    ['stub', stubFactory],
    // ['meta-whatsapp', metaWhatsappFactory],
    // ['twilio-sms', twilioSmsFactory],
    // ['vonage-sms', vonageSmsFactory],
    // ['gmail', gmailFactory],
    // ['http-sms', httpSmsFactory],
  ]);
}

/**
 * Stub provider factory (for development).
 */
const stubFactory: ProviderFactory = {
  id: 'stub',
  create: (config) => new StubProvider(config.state),
};

/**
 * Stub provider implementation.
 */
class StubProvider implements Provider {
  readonly id = 'stub';
  readonly channel = 'whatsapp' as const;

  constructor(private readonly state: MessagingState) {}

  async send(options: {
    config: unknown;
    channel: Channel;
    template: TemplateDefinition;
    input: unknown;
    policy?: DeliveryPolicy;
  }): Promise<{
    messageId: string;
    status: Promise<MessageStatus>;
  }> {
    // Stub: Log and return immediate 'sent' status
    console.log(`[Stub] Sending ${options.channel} message`);

    const messageId = `stub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    // Queue the message
    if (!this.state.queue.has(messageId)) {
      this.state.queue.set(messageId, []);
    }
    this.state.queue.get(messageId)!.push({
      id: messageId,
      kind: options.template.kind,
      channel: options.channel,
      status: 'pending' as const,
      statusTimestamp: now,
      templateId: options.template.id,
    });

    // Simulate delivery after short delay
    setTimeout(() => {
      this.state.queue.get(messageId) = this.state.queue.get(messageId)!;
      this.updateStatus(messageId, 'sent', now);
    }, 100);

    return {
      messageId,
      status: Promise.resolve({
        status: 'sent' as const,
        timestamp: now,
      }),
    };
  }

  async status(messageId: string): Promise<MessageStatus> {
    return {
      status: 'sent' as const,
      timestamp: new Date(),
    };
  }

  statusHandler?(request: Request): Response {
    console.log('[Stub] Webhook received');
    return new Response('OK', { status: 200 });
  }
}

/**
 * Messaging state.
 */
export interface MessagingState {
  templates: Map<string, TemplateDefinition>;
  queue: Map<string, MessageState[]>;
  store: Map<string, Map<string, MessageStatus>>;
  providers: Map<string, Provider>;
  policy: DeliveryPolicy;
  fallbackTimeout: number;
  ctx?: { waitUntil: (reason: Promise<any>) => void };
}

export interface MessageState {
  id: string;
  kind: TemplateKind;
  channel: Channel;
  status: DeliveryStatus;
  statusTimestamp: Date;
  templateId: string;
  createdAt: Date;
}

/**
 * Store message status in KV.
 */
export async function storeStatus(
  state: MessagingState,
  id: string,
  status: MessageStatus,
): Promise<void> {
  const entries = state.store.get(id) ?? [];
  entries.push({ status, timestamp: status.timestamp });
  state.store.set(id, entries);

  // TODO: Persist to KV with TTL
  // await state.kv.get(id, 'status', { encoding: 'utf-8' });
}

/**
 * Update message status.
 */
export async function updateStatus(
  state: MessagingState,
  id: string,
  status: DeliveryStatus,
  timestamp: Date,
): Promise<void> {
  // Update queue
  const queue = state.queue.get(id);
  if (queue) {
    const index = queue.findIndex((q) => q.id === id);
    if (index !== -1) {
      queue[index] = { ...queue[index], status, statusTimestamp: timestamp };
    }
    state.queue.set(id, queue);
  }

  // Update store
  await storeStatus(state, id, { status, timestamp });
}

/**
 * Queue a message.
 */
export async function queueMessage(
  state: MessagingState,
  id: string,
  messageState: MessageState,
): Promise<void> {
  if (!state.queue.has(id)) {
    state.queue.set(id, []);
  }
  state.queue.get(id)!.push(messageState);
}

/**
 * Deliver a message.
 */
export async function deliver(
  state: MessagingState,
  id: string,
  channel: Channel,
): Promise<void> {
  const provider = state.providers.get(channel);
  if (!provider) {
    throw new Error(`Provider not found for channel: ${channel}`);
  }

  const message = state.queue.get(id)?.find((m) => m.channel === channel && m.status === 'pending');
  if (!message) {
    return;
  }

  const result = await provider.send({
    config: state.providers.get(channel)!.id === channel ? {} : {},
    channel,
    template: state.templates.get(message.templateId)!,
    input: {}, // TODO: Extract from message
    policy: state.policy,
  });

  await updateStatus(state, id, 'sent', result.status.timestamp);
}

/**
 * Apply delivery status.
 */
export async function applyStatus(
  state: MessagingState,
  id: string,
  status: DeliveryStatus,
  timestamp: Date,
): Promise<void> {
  await updateStatus(state, id, status, timestamp);

  // Update overall message status
  const queue = state.queue.get(id);
  if (!queue) return;

  const statuses = new Map<Channel, DeliveryStatus>();
  for (const message of queue) {
    statuses.set(message.channel, message.status);
  }

  // Determine final status
  let finalStatus: DeliveryStatus;
  if (status === 'delivered' || status === 'read') {
    finalStatus = status;
  } else if (status === 'failed') {
    finalStatus = hasDelivered(statuses) ? 'delivered' : 'failed';
  } else {
    finalStatus = 'unknown';
  }

  const finalId = `overall-${id}`;
  state.store.set(finalId, [
    ...(state.store.get(finalId) ?? []),
    { status: finalStatus, timestamp },
  ]);
}

/**
 * Check if any channel has delivered.
 */
function hasDelivered(statuses: Map<Channel, DeliveryStatus>): boolean {
  return Array.from(statuses.values()).some((s) => s === 'delivered' || s === 'read');
}

/**
 * Apply fallback.
 */
export async function applyFallback(
  state: MessagingState,
  id: string,
  from: Channel,
  to: Channel,
  timeoutMs: number,
): Promise<void> {
  const provider = state.providers.get(to);
  if (!provider) {
    console.log(`[Fallback] No provider for channel: ${to}`);
    return;
  }

  const timestamp = new Date();
  provider.send({
    config: state.providers.get(to)!.id === to ? {} : {},
    channel: to,
    template: state.templates.get(id)!,
    input: {}, // TODO: Extract
    policy: state.policy,
  }).then(async (result) => {
    await updateStatus(state, id, 'sent', result.status.timestamp);
    await storeStatus(state, id, {
      status: 'sent',
      timestamp,
      details: { fallback: to },
    });
  });
}

/**
 * Apply fallback timer.
 */
export async function applyFallbackTimer(
  state: MessagingState,
  id: string,
  timeoutMs: number,
): Promise<void> {
  if (!state.ctx) {
    console.warn('[FallbackTimer] No ExecutionContext available');
    return;
  }

  const timerId = state.durable?.id;
  if (!timerId) {
    console.warn('[FallbackTimer] No Durable Object configured');
    return;
  }

  // TODO: Schedule alarm on Durable Object
  // await timer.setAlarm(timeoutMs);
}

/**
 * Handle failed delivery status.
 */
export async function handleFailure(
  state: MessagingState,
  id: string,
  channel: Channel,
  status: DeliveryStatus,
): Promise<void> {
  const policy = state.policy;

  // Check for always-on channels
  if (policy.alwaysOnChannels?.includes(channel)) {
    console.log(`[Delivery] Channel ${channel} marked as always-on`);
    return;
  }

  // Check for fallback chain
  if (policy.fallbackChain) {
    // Check if this is a fallback
    if (channel !== 'whatsapp') {
      return;
    }

    // Find next channel in fallbacks
    const fallback = policy.fallbacks?.find(
      (f) => f.from === 'whatsapp' && f.to !== channel && f.timeoutMs === 0,
    );

    if (fallback) {
      console.log(`[Delivery] Applying fallback from ${fallback.from} to ${fallback.to}`);
      await applyFallback(state, id, fallback.from, fallback.to, fallback.timeoutMs);
      return;
    }
  }

  // Mark message as failed
  if (!state.store.get(id)) {
    state.store.set(id, []);
  }
  state.store.get(id)!.push({
    status: status,
    timestamp: new Date(),
  });
}

/**
 * Create messaging application (with Hono integration).
 */
export function createMessagingApp(config: MessagingConfig): {
  app: { fetch: (request: Request) => Response };
  routes: {
    send: (channel: Channel | 'all') => (input: unknown) => Promise<MessageStatus>;
    webhooks: { [provider: string]: (request: Request) => Response };
  };
  handleDeliver: () => void;
  handleFallback: () => void;
} {
  const state = createMessaging(config);

  async function send(channel: Channel | 'all', input: unknown): Promise<MessageStatus> {
    // Validate input
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid template input');
    }

    const channels = channel === 'all' ? CHANNELS : [channel];
    const sentChannels: Channel[] = [];

    for (const ch of channels) {
      const provider = state.providers.get(ch);
      if (!provider) {
        console.log(`[Send] Skipping channel ${ch}: no provider`);
        continue;
      }

      // TODO: Send message
      // const result = await provider.send({...});
      // await storeStatus(state, id, { status: result.status, timestamp: result.status.timestamp });
      // await state.ctx?.waitUntil(result.status);

      const messageId = `stub-${Date.now()}`;
      const now = new Date();

      await queueMessage(state, messageId, {
        id: messageId,
        kind: 'text' as const,
        channel: ch,
        status: 'pending' as const,
        statusTimestamp: now,
        templateId: 'stub',
        createdAt: now,
      });

      // Simulate delivery
      await updateStatus(state, messageId, 'sent', now);

      sentChannels.push(ch);
    }

    return {
      status: 'sent' as const,
      timestamp: new Date(),
      channels: sentChannels,
    };
  }

  async function handleProviderStatus(providerId: string, status: MessageStatus): Promise<Response> {
    const provider = state.providers.get(providerId);
    if (!provider) {
      return new Response('Unknown provider', { status: 404 });
    }

    // TODO: Validate provider-specific status
    // const validated = await provider.status(status.messageId);

    // Apply status
    if (status.status === 'failed' || status.status === 'undelivered') {
      await handleFailure(state, status.messageId, providerId, status.status);
    }

    return new Response('OK', { status: 200 });
  }

  async function route(channel: Channel | 'all', input: unknown): Promise<MessageStatus> {
    const result = await send(channel, input);
    return result;
  }

  function handleDeliver(): void {
    // TODO: Periodically check delivery status and handle fallbacks
    // setInterval(() => {
    //   // Check all queued messages
    // }, 60000);
  }

  function handleFallback(): void {
    // TODO: Handle fallback timers
  }

  // Create Hono app
  const app = new Hono<{ Bindings: { [key: string]: any } }>();

  app.get('/send', async (c) => {
    const { channel, input } = c.req.valid('json');
    return c.json({ status: 'success', result: await send(channel, input) });
  });

  app.post('/send', async (c) => {
    const { channel, input } = c.req.valid('json');
    return c.json({ status: 'success', result: await send(channel, input) });
  });

  for (const [providerId, provider] of state.providers.entries()) {
    if (provider.statusHandler) {
      app.post(`/webhooks/${providerId}`, provider.statusHandler.bind(provider));
    }
  }

  return { app, routes: { send, webhooks: { stub: (r) => new Response('OK', { status: 200 }) } } };
}

/**
 * Define templates (stub).
 */
export function defineTemplates(templates: TemplateDefinition[]): void {
  // Stub: Store in a Map
  const registry = getRegistry();
  for (const template of templates) {
    registry.set(template.id, template);
  }
}

/**
 * Get registry (stub).
 */
function getRegistry(): Map<string, TemplateDefinition> {
  return new Map();
}
