/**
 * A direct conversation's own profile - the screen behind the person's name in a DM.
 *
 * **The name in a DM header used to lead nowhere**, deliberately: every other scope has a space
 * behind it and a DM does not, so a link to the club would have been the wrong screen with the
 * right person on it. This is that missing screen, and what it carries is the conversation
 * rather than the person: the clubs the two of you share, this thread's gallery, and the three
 * things you can do to the thread itself.
 *
 * That distinction is why it lives here and not on `/users/:id`. A member's profile is reachable
 * from any roster, where there may be no conversation at all - offering "Delete chat" there
 * would be a control over nothing. This screen exists only where a thread does.
 *
 * The three-dot menu is exactly Pin, Block and Delete chat. **Not** Archive, not Clear history,
 * not Remove contact, not Report a concern: reporting is per message and already lives on the
 * message, and the rest are features this product does not have.
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { channelApi, dmApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Avatar,
  Body,
  ConfirmDialog,
  DataScreen,
  SheetMenu,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function DmProfileScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const router = useRouter();
  const { client } = useSession();

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Both reads in one load, because the screen has nothing to show without either and two
   * independent spinners on one page is worse than one.
   */
  const load = useLoad(async () => {
    const meta = await channelApi.meta(channelId);
    const peerId = meta.peer?.userId ?? null;
    const shared = peerId === null ? { clubs: [] } : await dmApi.sharedClubs(peerId);
    return { meta, clubs: shared.clubs };
  }, [channelId]);

  const act = useCallback(
    async (run: () => Promise<unknown>, message: string) => {
      setMenuOpen(false);
      try {
        await run();
        setNotice(message);
        load.reload();
      } catch {
        setNotice('That did not work. Try again.');
      }
    },
    [load],
  );

  return (
    <>
      {/*
        The three dots, in the header where the design puts them - and installed from the screen
        rather than the layout because the menu's open state lives here. A control in the layout
        would need the state lifted out of the screen that uses it.
      */}
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="More options"
              hitSlop={space.sm}
              style={styles.headerButton}
            >
              <MaterialIcons name="more-horiz" size={22} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      <DataScreen load={load}>
      {(data) => {
        const peer = data.meta.peer;
        const pinned = data.meta.pinned;

        return (
          <Body>
            <View style={styles.identity}>
              <Avatar name={data.meta.name} image={data.meta.image} size={96} />
              <Text style={styles.name}>{data.meta.name}</Text>
              {/*
                A read-only thread says so here as well as at the composer. Blocking and losing
                the last shared club both leave history readable, so the screen is not empty and
                the reason belongs where somebody is looking for it.
              */}
              {!data.meta.canPost && <Text style={styles.readOnly}>You cannot send messages</Text>}
            </View>

            {notice !== null && <Text style={styles.notice}>{notice}</Text>}

            <View style={styles.rows}>
              {/*
                Shared clubs listed rather than counted behind a chevron. You will share one or
                two, not nine, so a whole screen to show one row would be a tap for nothing - and
                each is tappable through to that club, which a count could not be.
              */}
              <Text style={styles.sectionLabel}>
                {data.clubs.length === 0
                  ? 'No clubs in common'
                  : data.clubs.length === 1
                    ? '1 club in common'
                    : `${data.clubs.length} clubs in common`}
              </Text>

              {data.clubs.map((club) => (
                <Pressable
                  key={club.clubId}
                  style={styles.row}
                  onPress={() => router.push(`/clubs/${club.clubId}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${club.name}`}
                >
                  <Avatar name={club.name} image={club.image} size={40} kind="group" tintId={club.clubId} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {club.name}
                    </Text>
                    <Text style={styles.rowSub}>{club.sport}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
                </Pressable>
              ))}

              {/*
                This conversation's photographs. The gallery is scope-generic and a DM has had
                one since the media pipeline shipped; what was missing was a way in.
              */}
              <Pressable
                style={styles.row}
                onPress={() => router.push(`/channels/${channelId}/gallery`)}
                accessibilityRole="button"
                accessibilityLabel="Open this conversation's gallery"
              >
                <View style={styles.well}>
                  <MaterialIcons name="grid-view" size={20} color={color.onAccent} />
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>Gallery</Text>
                  <Text style={styles.rowSub}>Photos shared in this chat</Text>
                </View>
                <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
              </Pressable>
            </View>

            {menuOpen && (
              <SheetMenu
                title={data.meta.name}
                onDismiss={() => setMenuOpen(false)}
                items={[
                  {
                    label: pinned ? 'Unpin' : 'Pin',
                    onPress: () =>
                      void act(
                        () => channelApi.pin(channelId, !pinned),
                        pinned ? 'Unpinned.' : 'Pinned to the top of your chats.',
                      ),
                  },
                  ...(peer === null
                    ? []
                    : [
                        {
                          label: peer.blockedByMe ? 'Unblock' : 'Block',
                          destructive: !peer.blockedByMe,
                          onPress: () =>
                            void act(
                              () =>
                                peer.blockedByMe
                                  ? dmApi.unblock(peer.userId)
                                  : dmApi.block(peer.userId),
                              peer.blockedByMe ? 'Unblocked.' : 'Blocked.',
                            ),
                        },
                      ]),
                  {
                    label: 'Delete chat',
                    destructive: true,
                    onPress: () => {
                      setMenuOpen(false);
                      setConfirmClear(true);
                    },
                  },
                ]}
              />
            )}

            {/*
              Confirmation-gated, and the wording does the real work here. "Delete" sounds
              mutual, and it is not: saying so plainly is what stops somebody using this
              believing it reaches the other person, and stops somebody avoiding it believing
              it destroys their own record permanently.
            */}
            {confirmClear && (
              <ConfirmDialog
                title="Delete this chat?"
                body={`This clears the conversation for you only. ${
                  peer?.name ?? 'They'
                } will still have every message, and will not be told.`}
                confirmLabel="Delete chat"
                dismissLabel="Keep it"
                onCancel={() => setConfirmClear(false)}
                onConfirm={() => {
                  setConfirmClear(false);
                  void act(async () => {
                    await channelApi.clear(channelId);
                    // Drop the local copy too - see ChatClient.forgetChannel.
                    await client?.forgetChannel(channelId);
                    router.replace('/clubs');
                  }, 'Chat deleted for you.');
                }}
              />
            )}
          </Body>
        );
      }}
      </DataScreen>
    </>
  );
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center', gap: space.sm, paddingTop: space.sm, paddingBottom: space.md },
  name: {
    ...type.title,
    fontSize: 22,
    lineHeight: 28,
    color: color.textPrimary,
    textAlign: 'center',
  },
  readOnly: { ...type.bodySmall, color: color.textSecondary },

  notice: { ...type.bodySmall, color: color.accent, textAlign: 'center', marginBottom: space.sm },

  rows: { gap: space.sm },
  sectionLabel: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    marginTop: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...type.headline, fontSize: 16, color: color.textPrimary },
  rowSub: { ...type.bodySmall, color: color.textSecondary },
  well: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerButton: { paddingHorizontal: space.sm, paddingVertical: space.xs },
});
