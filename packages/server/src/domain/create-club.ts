/**
 * Club creation, and the bootstrap sequence it owns.
 *
 * In v1 this was a chain of database triggers firing each other, and the cost is
 * recorded as engineering pitfall 7: *"Ordering matters in bootstrap triggers. Create
 * the channel before adding the first member, or the first system message is silently
 * swallowed."* Implicit ordering between triggers is untestable, and it was wrong.
 *
 * Here the ordering is explicit, readable in one function, in one file, and covered
 * by one test. That is the entire argument of SPEC/TECH/04-effects-engine.md.
 */

import { randomBytes } from 'node:crypto';
import type { JoinPolicy } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import {
  channels,
  clubMemberships,
  clubs,
  eboardChannels,
  eboardMemberships,
  outbox,
} from '../db/schema.ts';

export type CreateClubInput = {
  name: string;
  sport: string;
  description?: string | null | undefined;
  joinPolicy?: JoinPolicy | undefined;
  creatorId: string;
};

export type CreateClubResult = {
  clubId: string;
  mainChannelId: string;
  eboardId: string;
  eboardChannelId: string;
  inviteToken: string;
};

/**
 * Mint an invite token.
 *
 * 32 bytes of CSPRNG output as base64url, matched exactly and case-sensitively. It is
 * never displayed as something a person types - it exists only inside a share link -
 * so it does not need to be short or case-insensitive, and both of those properties
 * existed only to serve manual entry. They are also precisely what made the v1 code
 * feasible to enumerate. See ADR-0010.
 */
export function mintInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createClub(db: Db, input: CreateClubInput): Promise<CreateClubResult> {
  return db.transaction(async (tx) => {
    const inviteToken = mintInviteToken();

    const clubRows = await tx
      .insert(clubs)
      .values({
        name: input.name,
        sport: input.sport,
        description: input.description ?? null,
        joinPolicy: input.joinPolicy ?? 'open',
        inviteToken,
        // The member link, minted here so a club is never without one. Two independent tokens:
        // deriving one from the other would make rotating either a lie. See ADR-0025.
        memberInviteToken: mintInviteToken(),
      })
      .returning();
    const club = clubRows[0];
    if (!club) throw new Error('club insert returned no row');

    // The creator becomes its Owner. The one-owner partial unique index makes this
    // the only owner row that can exist for this club, so a concurrent second
    // creation cannot produce an ambiguous club.
    await tx.insert(clubMemberships).values({
      clubId: club.id,
      userId: input.creatorId,
      role: 'owner',
    });

    // The main chat channel, before any member effect. scope_id is the club id, which
    // is what makes `UNIQUE (scope, scope_id)` mean "one main channel per club".
    const mainRows = await tx
      .insert(channels)
      .values({ clubId: club.id, scope: 'club', scopeId: club.id })
      .returning();
    const main = mainRows[0];
    if (!main) throw new Error('main channel insert returned no row');

    // The Eboard space, created automatically with the club rather than on first use.
    // Making it a manual "+ Create" step was rejected as pure friction: every club
    // wants one. The Owner is its first member.
    const eboardRows = await tx
      .insert(eboardChannels)
      .values({ clubId: club.id })
      .returning();
    const eboard = eboardRows[0];
    if (!eboard) throw new Error('eboard insert returned no row');

    const eboardChannelRows = await tx
      .insert(channels)
      .values({ clubId: club.id, scope: 'eboard', scopeId: eboard.id })
      .returning();
    const eboardChannel = eboardChannelRows[0];
    if (!eboardChannel) throw new Error('eboard channel insert returned no row');

    await tx.insert(eboardMemberships).values({
      eboardId: eboard.id,
      userId: input.creatorId,
    });

    // The effect note, in the same transaction as everything above. The worker turns
    // this into the club's first system message. If the transaction rolls back the
    // note goes with it, so there is no window in which a club exists without its
    // bootstrap effect or an effect fires for a club that does not.
    await tx.insert(outbox).values({
      // Partitioned by club, not channel: this event concerns the club as a whole and
      // its ordering domain is the club's own timeline.
      partitionKey: club.id,
      eventType: 'club.created',
      payload: {
        clubId: club.id,
        clubName: club.name,
        mainChannelId: main.id,
        eboardId: eboard.id,
        eboardChannelId: eboardChannel.id,
        creatorId: input.creatorId,
      },
    });

    return {
      clubId: club.id,
      mainChannelId: main.id,
      eboardId: eboard.id,
      eboardChannelId: eboardChannel.id,
      inviteToken,
    };
  });
}
