/**
 * FallbackTimer: the Durable Object whose alarm drives timed fallback (#8).
 *
 * One object per message, addressed by `idFromName(messageId)`. `arm` stores the render input
 * and sets the alarm; `cancel` clears both; `alarm` advances the chain when the message is
 * still `sent` — a status that simply never arrived — and cleans up. A chain still `pending`
 * at alarm time is re-checked after another delay rather than abandoned; a terminal chain
 * (`delivered`, `read`, `failed`) is only cleaned up.
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
import { type FallbackTimerClient, isTerminalChainStatus } from '../core/status.js';
import { armArgs, type ArmTimerArgs, registeredMessagingOptions } from '../core/timer.js';
import type { MessagingEnv } from '../env.js';
import { DurableObjectBase } from './base.js';

const STATE_KEY = 'timer';

/**
 * How many times an alarm that finds the chain still `pending` (the first attempt has not
 * settled yet) re-schedules itself for another `afterMs` before giving the message up. An
 * addition to the issue's two alarm outcomes (`sent` → advance, terminal → clean up), documented
 * in the README's "How delivery works".
 */
export const MAX_PENDING_RECHECKS = 3;

const logger = createLogger();

/**
 * What one armed timer keeps in its storage: the render input, the message id, the delay it
 * was armed with (so a `pending` chain can be re-checked) and how often that has happened.
 */
type StoredTimer = RenderInput & { id: string; afterMs: number; rechecks: number };

function toStored(args: ArmTimerArgs): StoredTimer {
  return { ...pickRenderInput(args), id: args.id, afterMs: args.afterMs, rechecks: 0 };
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
    if (!record || isTerminalChainStatus(record.chain.status)) {
      return;
    }
    if (record.chain.status === 'pending') {
      // The first attempt has not settled yet (a slow provider, or the OTP waitUntil path
      // outlasting the timeout). Nothing to advance from, but clearing now would leave the
      // message without a timer once it does record `sent`: come back after another delay.
      await this.recheck(stored);
      return;
    }
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

  /**
   * Re-schedules the alarm for a chain still `pending`, up to {@link MAX_PENDING_RECHECKS}
   * times; after that the alarm gives up and the storage is cleared by the caller.
   */
  private async recheck(stored: StoredTimer): Promise<void> {
    if (stored.rechecks >= MAX_PENDING_RECHECKS) {
      logger.warn('timer.gave-up', { id: stored.id, count: stored.rechecks });
      return;
    }
    this.generation += 1;
    await this.ctx.storage.put(STATE_KEY, { ...stored, rechecks: stored.rechecks + 1 });
    await this.ctx.storage.setAlarm(Date.now() + stored.afterMs);
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
   * Alarm handler: if the chain is still `sent`, advance it from the stored input; if it is
   * still `pending`, re-check later. Storage is cleared only once the advance has settled
   * without re-arming or re-scheduling the object; an advance that throws propagates with the
   * storage intact, so the platform's alarm retry finds the state it needs rather than an empty
   * object.
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
