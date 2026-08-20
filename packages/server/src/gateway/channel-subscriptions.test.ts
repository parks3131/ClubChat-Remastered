/**
 * The subscription bookkeeping behind per-channel fan-out.
 *
 * > **The defect this file exists for: a refused SUBSCRIBE killed live delivery for that
 * > channel, on that gateway, for the life of the process - silently.** The channel was put
 * > into the map BEFORE the Redis `SUBSCRIBE` was awaited, so a rejected subscribe unwound the
 * > await and left a permanent empty `Set` behind. Every later attach found a non-null Set, took
 * > the "first local subscriber already done" branch, and never issued SUBSCRIBE again. A
 * > two-second Redis blip therefore cost that channel its realtime, and nothing reported it:
 * > sends still acked, `/sync` still filled history, and the only symptom was messages that
 * > appeared when you left the chat and came back.
 *
 * The test is the reproduction: a subscriber whose first `subscribe` rejects, and a second
 * attach that must issue the SUBSCRIBE again.
 */

import { describe, expect, it, vi } from 'vitest';
import { channelTopic } from '../bus/redis.ts';
import { createChannelSubscriptions, type TopicSubscriber } from './channel-subscriptions.ts';

const CHANNEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CHANNEL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** A stub ioredis subscriber that records topics and can be told to refuse. */
function stubSubscriber(): TopicSubscriber & {
  subscribed: string[];
  unsubscribed: string[];
  failNextSubscribe: (error: Error) => void;
} {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let pendingFailure: Error | null = null;

  return {
    subscribed,
    unsubscribed,
    failNextSubscribe(error) {
      pendingFailure = error;
    },
    async subscribe(topic: string) {
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = null;
        // Recorded even when refused: what matters is whether the gateway ASKED, and a
        // stub that hid the refused attempt could not tell "retried" from "never tried".
        subscribed.push(topic);
        throw error;
      }
      subscribed.push(topic);
      return 1;
    },
    async unsubscribe(topic: string) {
      unsubscribed.push(topic);
      return 0;
    },
  };
}

describe('channel subscriptions', () => {
  it('subscribes once for the first socket and reuses it for the rest', async () => {
    const subscriber = stubSubscriber();
    const subs = createChannelSubscriptions<string>(subscriber);

    await subs.attach('socket-a', CHANNEL);
    await subs.attach('socket-b', CHANNEL);

    expect(subscriber.subscribed).toEqual([channelTopic(CHANNEL)]);
    expect([...(subs.socketsFor(CHANNEL) ?? [])]).toEqual(['socket-a', 'socket-b']);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * A rejected SUBSCRIBE must leave NOTHING behind. If it registers the channel anyway, the
   * retry below sees a non-null Set, believes another socket already subscribed, and the
   * gateway never asks Redis for this channel again.
   */
  it('retries the SUBSCRIBE after a refused one, rather than leaving an empty channel behind', async () => {
    const subscriber = stubSubscriber();
    const subs = createChannelSubscriptions<string>(subscriber);

    subscriber.failNextSubscribe(new Error('Stream isn\'t writeable'));
    await expect(subs.attach('socket-a', CHANNEL)).rejects.toThrow();

    // Nothing registered, because nothing was subscribed. A caller asking who to fan out to
    // must not be told "this channel, and nobody" - that is indistinguishable from a channel
    // whose last socket just left.
    expect(subs.socketsFor(CHANNEL)).toBeUndefined();
    expect(subs.channelCount()).toBe(0);

    // The blip is over. The next socket to open this channel must subscribe again.
    await subs.attach('socket-b', CHANNEL);

    expect(subscriber.subscribed).toEqual([channelTopic(CHANNEL), channelTopic(CHANNEL)]);
    expect([...(subs.socketsFor(CHANNEL) ?? [])]).toEqual(['socket-b']);
  });

  it('unsubscribes when the last socket leaves, and not before', async () => {
    const subscriber = stubSubscriber();
    const subs = createChannelSubscriptions<string>(subscriber);

    await subs.attach('socket-a', CHANNEL);
    await subs.attach('socket-b', CHANNEL);

    subs.detach('socket-a', CHANNEL);
    expect(subscriber.unsubscribed).toEqual([]);

    subs.detach('socket-b', CHANNEL);
    expect(subscriber.unsubscribed).toEqual([channelTopic(CHANNEL)]);
    expect(subs.socketsFor(CHANNEL)).toBeUndefined();
  });

  it('detaching a channel it does not hold is a no-op', async () => {
    const subscriber = stubSubscriber();
    const subs = createChannelSubscriptions<string>(subscriber);

    await subs.attach('socket-a', CHANNEL);
    subs.detach('socket-a', OTHER_CHANNEL);

    expect(subscriber.unsubscribed).toEqual([]);
    expect(subs.channelCount()).toBe(1);
  });

  it('reports a failed unsubscribe rather than swallowing it', async () => {
    const subscriber = stubSubscriber();
    const failure = new Error('connection is closed');
    subscriber.unsubscribe = async () => {
      throw failure;
    };
    const onUnsubscribeFailed = vi.fn();
    const subs = createChannelSubscriptions<string>(subscriber, { onUnsubscribeFailed });

    await subs.attach('socket-a', CHANNEL);
    subs.detach('socket-a', CHANNEL);

    await vi.waitFor(() => expect(onUnsubscribeFailed).toHaveBeenCalledWith(CHANNEL, failure));
  });
});
