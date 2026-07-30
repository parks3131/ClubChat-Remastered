/**
 * The authenticated fetch, and the shapes the DM screens read.
 *
 * Every screen previously loaded the token and assembled its own headers inline. That is the
 * same duplication the server's policy module exists to avoid, one layer up: a header the
 * next screen forgets is an unauthenticated request that reads as an empty list.
 *
 * Deliberately thin. It does NOT wrap the realtime path - `ChatClient` owns the socket, the
 * outbox and the local store, and a second opinion about sending would be a second source of
 * truth about what has been delivered.
 */

import type { MessageReaction, ReactionEmoji } from '@clubchat/shared';
import { config } from './config.ts';
import { sessionStore } from './session.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

/**
 * Call the API with the stored session token.
 *
 * Throws `ApiError` on a non-2xx, so a caller can distinguish "not found" from "offline" -
 * a thrown `TypeError` from fetch means the network, and every screen treats the two
 * differently.
 */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await sessionStore.load();
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token ?? ''}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* a non-JSON body is still a failure, just an unhelpful one */
    }
    throw new ApiError(response.status, message);
  }

  // 204 and an empty body are legitimate for a delete.
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

export type DmThread = {
  conversationId: string;
  channelId: string;
  otherUserId: string;
  otherName: string;
  unread: number;
  canPost: boolean;
  muted: boolean;
  lastMessage: { body: string | null; seq: number; createdAt: string } | null;
};

export type DmCandidate = { userId: string; name: string };

/**
 * Whether the composer is live, and why not.
 *
 * `unavailable` covers both "they blocked you" and "you no longer share a club", and does not
 * say which. That is the non-disclosing resolution of PRD/14's open question: the member learns
 * they cannot send, which is what they need, without learning they were specifically blocked,
 * which rule 6 keeps quiet in search and in notifications too.
 */
export type PostDeniedReason = 'you_blocked_them' | 'unavailable';

export type ChannelMeta = {
  channelId: string;
  scope: 'club' | 'race' | 'eboard' | 'dm';
  name: string;
  canPost: boolean;
  postDeniedReason: PostDeniedReason | null;
  canPin: boolean;
  muted: boolean;
  peer: { userId: string; name: string; blockedByMe: boolean } | null;
};

export const dmApi = {
  threads: () => apiFetch<{ threads: DmThread[] }>('/dm/threads'),

  candidates: (query: string) =>
    apiFetch<{ candidates: DmCandidate[] }>(
      `/dm/candidates${query.trim().length > 0 ? `?q=${encodeURIComponent(query.trim())}` : ''}`,
    ),

  open: (userId: string) =>
    apiFetch<{ conversationId: string; channelId: string }>('/dm/threads', {
      method: 'POST',
      body: { userId },
    }),

  meta: (channelId: string) => apiFetch<ChannelMeta>(`/channels/${channelId}`),

  block: (userId: string) => apiFetch<unknown>('/blocks', { method: 'POST', body: { userId } }),

  unblock: (userId: string) => apiFetch<unknown>(`/blocks/${userId}`, { method: 'DELETE' }),

  mute: (channelId: string) =>
    apiFetch<unknown>(`/channels/${channelId}/mute`, { method: 'POST', body: {} }),

  unmute: (channelId: string) =>
    apiFetch<unknown>(`/channels/${channelId}/mute`, { method: 'DELETE' }),

  report: (channelId: string, seq: number) =>
    apiFetch<{ alreadyReported: boolean }>(`/channels/${channelId}/messages/${seq}/report`, {
      method: 'POST',
      body: {},
    }),

  /**
   * Toggle a reaction, returning the FULL resulting set rather than the delta.
   *
   * One endpoint for on and off. Deciding which to call in the client would be a
   * read-then-write across the network, racing the other device the same member is holding -
   * and the server's own toggle is a keyed delete-or-insert precisely so it cannot.
   */
  reactionToggle: (channelId: string, seq: number, emoji: ReactionEmoji) =>
    apiFetch<{ added: boolean; reactions: MessageReaction[] }>(
      `/channels/${channelId}/messages/${seq}/reactions`,
      { method: 'POST', body: { emoji } },
    ),

  /** Who reacted, for a who-reacted sheet. Reactions are visible to everyone with access. */
  reactionsFor: (channelId: string, seq: number) =>
    apiFetch<{ reactions: MessageReaction[] }>(
      `/channels/${channelId}/messages/${seq}/reactions`,
    ),
};

// ---------------------------------------------------------------------------
// Media URLs
// ---------------------------------------------------------------------------

/**
 * Resolved media URLs, memoized in process.
 *
 * > **The memo is sound because of the hour alignment, not in spite of it.** The signed URL is
 * > byte-identical for every viewer inside a window, which is exactly what makes it safe to hold
 * > and share - the same property that turns 300 members looking at one photo into one CDN cache
 * > entry instead of 300 origin fetches.
 *
 * Keyed by media id and variant. Dropped once past its expiry, so a client that stays open
 * across the hour boundary re-resolves rather than rendering a broken image.
 */
const mediaUrlMemo = new Map<string, { url: string; expiresAt: number }>();

export type MediaVariant = 'original' | 'display' | 'thumb';

/**
 * Turn a media id into a fetchable URL, through the authorized hop.
 *
 * Every resolve is an authorization decision re-evaluated server-side, which is why this is a
 * request and not a string template. The result is only a URL for bytes whose key is already
 * unguessable - it grants fetchability, never access.
 */
export async function resolveMediaUrl(
  mediaId: string,
  variant: MediaVariant = 'display',
): Promise<string> {
  const key = `${mediaId}:${variant}`;
  const held = mediaUrlMemo.get(key);
  // A minute of headroom, so a URL is never handed out with less life left than the request
  // that uses it might take.
  if (held && held.expiresAt - Date.now() > 60_000) return held.url;

  const resolved = await apiFetch<{ url: string; expiresAt: string }>(
    `/media/${mediaId}/url?variant=${variant}`,
  );
  mediaUrlMemo.set(key, {
    url: resolved.url,
    expiresAt: new Date(resolved.expiresAt).getTime(),
  });
  return resolved.url;
}
