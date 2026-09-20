/**
 * FallbackTimer: the Durable Object whose alarm drives timed fallback (#8).
 *
 * One object per message, addressed by `idFromName(messageId)`. `arm` stores the render input
 * and sets the alarm; `cancel` clears both; `alarm` advances the chain when the message is
 * still `sent` — a status that simply never arrived — and cleans up.
 *
 * The object rebuilds the core from the options the Worker registered with
 * `createMessagingApp` / `createMessaging`. An isolate woken only by an alarm runs nothing but
 * module evaluation before the handler, so that call must happen at module top level of the
 * Worker module that exports this class — not lazily inside a request handler. When no options
 * are registered the alarm logs `timer.unconfigured`, throws (the platform retries it) and keeps
 * its storage.
 *
 * @module
 */

import { createLogger } from '../core/logger.js';
import { advanceChainFor, MessagingConfigError, statusStoreFor } from '../core/messaging.js';
import { pickRenderInput, type RenderInput } from '../core/render-input.js';
import type { FallbackTimerClient } from '../core/status.js';
import { armArgs, type ArmTimerArgs, registeredMessagingOptions } from '../core/timer.js';
import type { MessagingEnv } from '../env.js';
import { DurableObjectBase } from './base.js';

const STATE_KEY = 'timer';

const logger = createLogger();

/**
 * What one armed timer keeps in its storage: the render input plus the message id.
 */
type StoredTimer = RenderInput & { id: string };

function toStored(args: ArmTimerArgs): StoredTimer {
  return { ...pickRenderInput(args), id: args.id };
}

/**
 * Durable Object for timed fallback: fires `advanceChain({ reason: 'timeout' })` when a chain
 * is still `sent` after the kind's timeout.
 */
export class FallbackTimer extends DurableObjectBase<MessagingEnv> {
  /**
   * Bumped by every `arm`, so the alarm can tell whether the advance it ran re-armed the object
   * (leave the new state alone) or left it terminal (clear).
   */
  private generation = 0;

  private async advance(stored: StoredTimer): Promise<void> {
    const options = registeredMessagingOptions();
    if (!options) {
      logger.warn('timer.unconfigured', { id: stored.id });
      throw new MessagingConfigError(
        'FallbackTimer found no messaging options in this isolate: call createMessagingApp ' +
          '(or createMessaging) at module top level of the Worker that exports the class'
      );
    }
    const record = await statusStoreFor(this.env, options).get(stored.id);
    if (record?.chain.status !== 'sent') {
      return;
    }
    logger.info('fallback.advance', { id: stored.id, kind: record.kind });
    await advanceChainFor(this.env, options, {
      id: stored.id,
      reason: 'timeout',
      input: pickRenderInput(stored),
      timer: this.self(),
    });
  }

  /**
   * This object as the timer client the fallback path re-arms and cancels through, so an
   * advance running inside the alarm writes this object's storage directly instead of calling
   * its own stub.
   */
  private self(): FallbackTimerClient {
    return {
      setState: (id, timeoutMs, input) => this.arm(armArgs(id, timeoutMs, input)),
      cancel: (id) => this.cancel(id),
    };
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Stores the render input and schedules the alarm for `now + afterMs`, replacing any earlier
   * alarm on this object.
   *
   * @param args - Message id, delay and the input to re-render from.
   */
  async arm(args: ArmTimerArgs): Promise<void> {
    if (!Number.isFinite(args.afterMs) || args.afterMs < 0) {
      throw new RangeError('afterMs must be a non-negative number of milliseconds');
    }
    this.generation += 1;
    await this.ctx.storage.put(STATE_KEY, toStored(args));
    await this.ctx.storage.setAlarm(Date.now() + args.afterMs);
  }

  /**
   * Deletes the alarm and everything stored; called when the chain reaches a terminal state.
   *
   * @param _id - Message id (the object is already the one for this message).
   */
  async cancel(_id: string): Promise<void> {
    await this.clear();
  }

  /**
   * Alarm handler: if the chain is still `sent`, advance it from the stored input. Storage is
   * cleared only once the advance has settled without re-arming the object; an advance that
   * throws propagates with the storage intact, so the platform's alarm retry finds the state it
   * needs rather than an empty object.
   */
  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredTimer>(STATE_KEY);
    if (!stored) {
      await this.clear();
      return;
    }
    const generation = this.generation;
    await this.advance(stored);
    if (this.generation === generation) {
      await this.clear();
    }
  }
}
