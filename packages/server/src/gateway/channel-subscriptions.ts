/**
 * Which sockets this gateway holds for each channel, and the Redis subscription behind them.
 *
 * Lifted out of `server.ts` so it can be exercised without a database, an auth stack or a
 * listening port. The bug it exists to make testable is described on `attach`.
 *
 * The map is private on purpose: a `Map<string, Set<Socket>>` reachable from the outside is an
 * invariant anybody can break, and the invariant here is narrow - **an entry exists only for a
 * channel this process has an accepted Redis SUBSCRIBE for.**
 */

import { channelTopic } from '../bus/redis.ts';

/** The half of ioredis this file uses. Narrow, so a test can supply it in three lines. */
export type TopicSubscriber = {
  subscribe(topic: string): Promise<unknown>;
  unsubscribe(topic: string): Promise<unknown>;
};

export type ChannelSubscriptions<Socket> = {
  /** Start delivering this channel to this socket. Throws if the SUBSCRIBE is refused. */
  attach(socket: Socket, channelId: string): Promise<void>;
  /** Stop delivering this channel to this socket, and drop the topic when nobody is left. */
  detach(socket: Socket, channelId: string): void;
  /** The sockets to fan a published envelope out to, or undefined for a channel we do not hold. */
  socketsFor(channelId: string): ReadonlySet<Socket> | undefined;
  /** How many channels this gateway is currently subscribed to. Diagnostics and tests. */
  channelCount(): number;
};

export function createChannelSubscriptions<Socket>(
  subscriber: TopicSubscriber,
  opts: { onUnsubscribeFailed?: (channelId: string, error: unknown) => void } = {},
): ChannelSubscriptions<Socket> {
  /** channelId -> sockets subscribed to it, for in-process fan-out. */
  const byChannel = new Map<string, Set<Socket>>();

  return {
    /**
     * Start delivering this channel to this socket.
     *
     * > **The SUBSCRIBE comes first, and the entry in the map is what proves it succeeded.**
     * > This used to `byChannel.set(channelId, new Set())` and only then await the subscribe -
     * > so a refused SUBSCRIBE unwound the await and left a permanent EMPTY Set behind. Every
     * > later attach then found a non-null Set, took the branch that says "another socket
     * > already subscribed", and the gateway never asked Redis for that channel again. A
     * > two-second Redis blip cost that channel its live delivery for the whole life of the
     * > process, silently: sends still acked, `/sync` still filled history, and the only
     * > symptom was messages that appeared on re-entering the chat.
     *
     * A throw here is therefore the point rather than an inconvenience. It leaves the map
     * exactly as it was, so the next attach is a clean retry, and it gives the caller
     * something to refuse the frame with.
     */
    async attach(socket, channelId) {
      const existing = byChannel.get(channelId);
      if (existing) {
        existing.add(socket);
        return;
      }

      // First local subscriber for this channel: start listening. A gateway holding no
      // member of a channel receives nothing at all, which is the point of
      // per-channel topics.
      await subscriber.subscribe(channelTopic(channelId));

      /*
       * Re-read rather than reuse a Set built before the await. Two sockets opening the same
       * channel at the same instant both reach the subscribe (which Redis treats as idempotent),
       * and whichever lands second must join the set the first one registered rather than
       * replace it - replacing it would drop a live socket out of the fan-out with no error.
       */
      let sockets = byChannel.get(channelId);
      if (!sockets) {
        sockets = new Set();
        byChannel.set(channelId, sockets);
      }
      sockets.add(socket);
    },

    detach(socket, channelId) {
      const sockets = byChannel.get(channelId);
      if (!sockets) return;
      sockets.delete(socket);
      if (sockets.size === 0) {
        byChannel.delete(channelId);
        void subscriber
          .unsubscribe(channelTopic(channelId))
          .catch((error: unknown) => opts.onUnsubscribeFailed?.(channelId, error));
      }
    },

    socketsFor(channelId) {
      return byChannel.get(channelId);
    },

    channelCount() {
      return byChannel.size;
    },
  };
}
