/**
 * News & Highlights: the club's front page.
 *
 * **A pinned chat message is a reference; a news post is a publication.** The two surfaces coexist
 * deliberately, which is why this screen has no pinning and no ordering controls - it is
 * reverse-chronological, and that is the whole ordering model (`PRD/06` rule 2).
 *
 * Any club admin creates, edits or deletes **any** post, not only their own. Every member reads and
 * reacts. Creating notifies everybody; editing and deleting notify nobody, except somebody newly
 * named in an edit (ADR-0040).
 *
 * The card and the composer are specified in [`DESIGN/13`](../../../../../../SPEC/DESIGN/13-news-post.md).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { clubApi, contentApi, type MemberCandidate } from '../../../../../src/api.ts';
import type { NewsPost } from '../../../../../src/api-types.ts';
import { centredRectForRatio, toSourceRect } from '../../../../../src/crop-rect.ts';
import { EmojiPicker } from '../../../../../src/emoji-picker.tsx';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { BackStep, BackTo } from '../../../../../src/nav.tsx';
import {
  pickPhotos,
  uploadAttachment,
  UploadError,
  type PickedPhoto,
} from '../../../../../src/upload.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Avatar,
  Body,
  Card,
  ConfirmDialog,
  ContextMenu,
  DataScreen,
  EmptyState,
  Field,
  measureRow,
  SectionHeader,
  type ContextMenuItem,
  type PressAnchor,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** ADR-0038. The composer, the route and a constraint each enforce this independently. */
const MAX_PHOTOS = 6;

/** The three shapes a carousel can be drawn in, and the number each one is. */
const ASPECTS = [
  { key: '1:1' as const, label: 'Square', ratio: 1 },
  { key: '4:5' as const, label: 'Portrait', ratio: 4 / 5 },
  { key: '16:9' as const, label: 'Wide', ratio: 16 / 9 },
];

type Aspect = (typeof ASPECTS)[number]['key'];

const ratioOf = (aspect: string): number =>
  ASPECTS.find((entry) => entry.key === aspect)?.ratio ?? 1;

export default function ClubNewsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [composing, setComposing] = useState(false);
  /**
   * The post being edited, held whole rather than by id.
   *
   * The feed has already read every field the composer needs, so seeding from this object opens
   * the form filled in with no second request and no spinner over a form somebody is looking at.
   */
  const [editing, setEditing] = useState<NewsPost | null>(null);
  const [search, setSearch] = useState('');

  // The query is part of the load key, so typing re-reads rather than filtering a stale page.
  const feed = useLoad(
    () => contentApi.news(clubId, undefined, search.trim() || undefined),
    [clubId, search],
  );
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  if (composing || editing !== null) {
    return (
      <ComposePost
        /*
          Keyed by what it is composing, so switching between writing a new post and editing an
          existing one REMOUNTS rather than reusing the state.

          `useState` initialisers run once per mount. Without this key, opening Edit after
          cancelling a New post would keep the half-typed draft and ignore the post entirely -
          the fields are seeded at mount and the mount never happened again.
        */
        key={editing?.id ?? 'new'}
        clubId={clubId}
        channelId={club.data?.club.channelId ?? null}
        post={editing}
        onCancel={() => {
          setComposing(false);
          setEditing(null);
        }}
        onPosted={() => {
          setComposing(false);
          setEditing(null);
          feed.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
      {/*
        The feed puts the header BACK, and this is not belt and braces.

        `Stack.Screen` options are `setOptions` underneath: whatever the composer installed
        survives the composer being unmounted. Without this the arrow kept calling the composer's
        cancel after returning to the feed, so it silently did nothing - the same "back button
        apparently dead" failure `dismissTo` was written for, arrived at from the other side.

        It restates what `(main)/_layout.tsx` declares for this route. Two places saying one
        thing is a real cost; the alternative is a control that works until somebody opens the
        composer once.
      */}
      <Stack.Screen
        options={{
          headerLeft: () => <BackTo href={`/clubs/${clubId}`} label="Club" variant="icon" />,
          gestureEnabled: true,
        }}
      />

      {/* PRD/06 rule 17. Titles and tags, within this club and never across clubs. */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search posts and #tags"
          placeholderTextColor={color.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search this club's posts"
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable
            onPress={() => setSearch('')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Clear the search"
          >
            <Text style={styles.searchClear}>Clear</Text>
          </Pressable>
        )}
      </View>

      <DataScreen
        load={feed}
        isEmpty={(data) => data.posts.length === 0}
        empty={
          search.trim().length > 0 ? (
            <EmptyState title="Nothing matches" body="Try another word, or a different tag." />
          ) : (
            <EmptyState
              title="No news yet"
              body={isAdmin ? 'Post a result, a recap or a photo drop.' : undefined}
            />
          )
        }
      >
        {(data) => (
          <Body>
            {data.posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                isAdmin={isAdmin}
                onChanged={feed.reload}
                onSearchTag={setSearch}
                onEdit={() => setEditing(post)}
              />
            ))}
            {data.hasMore && <Text style={styles.meta}>Older posts load as you scroll.</Text>}
          </Body>
        )}
      </DataScreen>

      {isAdmin && (
        <View style={styles.footer}>
          <Action label="New post" onPress={() => setComposing(true)} />
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function PostCard({
  post,
  isAdmin,
  onChanged,
  onSearchTag,
  onEdit,
}: {
  post: NewsPost;
  /**
   * Whether the viewer administers this club, which is the whole permission question here.
   *
   * `PRD/06` rule 3: any club admin may edit or delete ANY post, not only the one they wrote -
   * a post is club content published on the club's behalf, and an author-only rule would leave a
   * demoted or departed admin's posts unremovable by anybody. So this is deliberately not
   * compared against `post.authorId`.
   */
  isAdmin: boolean;
  onChanged: () => void;
  onSearchTag: (tag: string) => void;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<PressAnchor | null>(null);
  const menuButton = useRef<View | null>(null);

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Edit post',
      icon: 'edit',
      onPress: () => {
        setMenuAnchor(null);
        onEdit();
      },
    },
    {
      label: 'Delete post',
      icon: 'delete',
      destructive: true,
      onPress: () => {
        // The menu closes BEFORE the dialog opens. ContextMenu is a real Modal and ConfirmDialog
        // is another, and iOS presents one per view controller - the second would never appear.
        setMenuAnchor(null);
        setConfirming(true);
      },
    },
  ];

  return (
    <Card>
      {/*
        The "..." in the card's own top-right corner, where a post's controls live everywhere
        else. It replaced a full-width "Delete post" button along the bottom of every card, which
        spent a row of the feed on the rarest action and offered no room for the commoner one.

        `PRD/06` rule 20: a member sees no create, edit or delete controls at all - so for them
        there is no button rather than a menu that opens onto nothing, which is `DESIGN/10` rule 5.
      */}
      {isAdmin && (
        <View
          style={styles.cardMenuHost}
          ref={(view) => {
            menuButton.current = view as unknown as View | null;
          }}
          collapsable={false}
        >
          <Pressable
            style={styles.cardMenuButton}
            hitSlop={space.sm}
            onPress={(event) =>
              measureRow(
                menuButton.current,
                { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
                (anchor) => setMenuAnchor(anchor),
              )
            }
            accessibilityRole="button"
            accessibilityLabel={`Options for this post by ${post.authorName}`}
          >
            <MaterialIcons name="more-vert" size={20} color={color.textSecondary} />
          </Pressable>
        </View>
      )}

      {menuAnchor !== null && (
        <ContextMenu
          anchor={menuAnchor}
          items={menuItems}
          onDismiss={() => setMenuAnchor(null)}
        />
      )}

      {/*
        Raised over the feed rather than unfolded inside the card.

        It was an inline block: the button swapped for a sentence and a Keep/Delete row within the
        card's own flow, which reflowed the post underneath it and read as part of the post rather
        than as a question about it. A permanent deletion deserves the same treatment as blocking
        somebody, and that is a dialog.
      */}
      {confirming && (
        <ConfirmDialog
          title="Delete this post?"
          // Names what is lost. A post has no tombstone, unlike a deleted chat message.
          body="This removes the post, its photos and its reactions for everybody, permanently. Unlike a chat message it leaves nothing behind."
          confirmLabel="Delete"
          dismissLabel="Keep"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void contentApi.deleteNews(post.id).then(onChanged, onChanged);
          }}
        />
      )}

      <View style={styles.author}>
        <Avatar name={post.authorName} image={post.authorImage} />
        <View style={styles.authorText}>
          {/* Every post shows its creator's name and post time. */}
          <Text style={styles.name}>{post.authorName}</Text>
          <Text style={styles.meta}>
            {post.createdAt.slice(0, 16).replace('T', ' ')}
            {post.updatedAt !== post.createdAt ? '  ·  edited' : ''}
          </Text>
        </View>
      </View>

      {/* Absent when there is none, and then the body is the headline. */}
      {post.title !== null && <Text style={styles.title}>{post.title}</Text>}

      {post.mediaIds.length > 0 && (
        <Carousel mediaIds={post.mediaIds} aspect={post.aspect} authorName={post.authorName} />
      )}

      {post.locationName !== null && <LocationRow post={post} />}

      {post.body !== null && <Text style={styles.body}>{post.body}</Text>}

      {/* A line rather than a chip row: the card already has one chip row and it is the tags. */}
      {post.people.length > 0 && <Text style={styles.people}>{namesLine(post.people)}</Text>}

      {post.tags.length > 0 && (
        <View style={styles.tagRow}>
          {post.tags.map((tag) => (
            <Pressable
              key={tag}
              style={styles.tagChip}
              onPress={() => onSearchTag(`#${tag}`)}
              accessibilityRole="button"
              accessibilityLabel={`Search for #${tag}`}
            >
              <Text style={styles.tagText}>#{tag}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <ReactionRow post={post} onChanged={onChanged} />
    </Card>
  );
}

/**
 * "With Molly Chen and 2 others".
 *
 * Built from parts and never a joined string, the same rule the content card's meta line holds:
 * one name reads differently from two, and two differently from a crowd.
 */
function namesLine(people: NewsPost['people']): string {
  const names = people.map((person) => person.name);
  if (names.length === 1) return `With ${names[0]}`;
  if (names.length === 2) return `With ${names[0]} and ${names[1]}`;
  return `With ${names[0]}, ${names[1]} and ${names.length - 2} ${
    names.length - 2 === 1 ? 'other' : 'others'
  }`;
}

/**
 * The place, and a link when there is one.
 *
 * **Only pressable when it has somewhere to go** (DESIGN/13 rule 6). A row that invites a tap and
 * does nothing is worse than one that plainly does not.
 */
function LocationRow({ post }: { post: NewsPost }) {
  const line = (
    <>
      <MaterialIcons
        name="place"
        size={18}
        color={post.locationUrl ? color.accent : color.textSecondary}
      />
      <Text style={post.locationUrl ? styles.locationLink : styles.location}>
        {post.locationName}
      </Text>
    </>
  );

  if (post.locationUrl === null) return <View style={styles.locationRow}>{line}</View>;

  return (
    <Pressable
      style={styles.locationRow}
      onPress={() => void Linking.openURL(post.locationUrl!).catch(() => undefined)}
      accessibilityRole="link"
      accessibilityLabel={`Open ${post.locationName}`}
    >
      {line}
    </Pressable>
  );
}

/**
 * The gallery: one box, every slide the same shape, a counter and page dots.
 *
 * **One photo is not a degenerate carousel** (DESIGN/13 rule 10): no dots, no counter, no swipe,
 * because there is nothing to page through.
 */
function Carousel({
  mediaIds,
  aspect,
  authorName,
}: {
  mediaIds: string[];
  aspect: string;
  authorName: string;
}) {
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(0);
  const ratio = ratioOf(aspect);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      setPage(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  const frame = { width: '100%' as const, aspectRatio: ratio };

  if (mediaIds.length === 1) {
    return (
      <RemoteImage
        mediaId={mediaIds[0]!}
        style={[styles.photo, frame]}
        resizeMode="cover"
        accessibilityLabel={`Photo posted by ${authorName}`}
      />
    );
  }

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={[styles.photo, frame]}
      >
        {mediaIds.map((mediaId, index) => (
          <RemoteImage
            key={mediaId}
            mediaId={mediaId}
            style={{ width, aspectRatio: ratio }}
            resizeMode="cover"
            accessibilityLabel={`Photo ${index + 1} of ${mediaIds.length}, posted by ${authorName}`}
          />
        ))}
      </ScrollView>

      <View style={styles.counter} pointerEvents="none">
        <Text style={styles.counterText}>
          {page + 1} / {mediaIds.length}
        </Text>
      </View>

      <View style={styles.dots} pointerEvents="none">
        {mediaIds.map((mediaId, index) => (
          <View key={mediaId} style={[styles.dot, index === page && styles.dotOn]} />
        ))}
      </View>
    </View>
  );
}

/**
 * Chat's reaction row, on a post.
 *
 * News had a fixed row of six with no picker until 2026-08-16. It has the same pills, the same
 * `+` over the whole catalog, and the same meaning everywhere in the product now - see
 * [`DESIGN/07`](../../../../../../SPEC/DESIGN/07-reactions.md).
 */
function ReactionRow({ post, onChanged }: { post: NewsPost; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);

  const react = (emoji: string) => {
    void contentApi.toggleNewsReaction(post.id, emoji as never).then(onChanged, onChanged);
  };

  return (
    <>
      <View style={styles.reactions}>
        {/* Only what somebody has actually used. An unused emoji is not a control. */}
        {post.reactions.map((entry) => (
          <Pressable
            key={entry.emoji}
            style={[styles.pill, entry.mine && styles.pillMine]}
            onPress={() => react(entry.emoji)}
            accessibilityRole="button"
            accessibilityLabel={`${entry.emoji}, ${entry.count}${
              entry.mine ? ', remove yours' : ', react too'
            }`}
          >
            <Text style={styles.pillText}>
              {entry.emoji} {entry.count}
            </Text>
          </Pressable>
        ))}

        <Pressable
          style={styles.addReaction}
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          accessibilityLabel="Add a reaction"
        >
          <Text style={styles.addReactionText}>+</Text>
        </Pressable>
      </View>

      {picking && (
        <EmojiPicker
          onDismiss={() => setPicking(false)}
          onPick={(emoji) => {
            setPicking(false);
            react(emoji);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** A photo that is on its way up, or has arrived, or failed. The thumbnail draws all three. */
type Slot = {
  /** Stable across a retry, so React does not remount the tile and lose its place in the row. */
  key: string;
  /**
   * The file on this phone, or **null for a photo that is already on the server**.
   *
   * An edit opens with the post's existing gallery, and those photos have no local original: the
   * phone chose the rectangle and the server cut the pixels at upload time (DESIGN/11 rule 3), so
   * what exists now is the cropped result and nothing else. That single fact decides three things
   * below - such a slot needs no upload, draws from its `mediaId` rather than a `uri`, and cannot
   * be re-cropped into a different shape.
   */
  picked: PickedPhoto | null;
  mediaId: string | null;
  failed: boolean;
};

function ComposePost({
  clubId,
  channelId,
  post,
  onCancel,
  onPosted,
}: {
  clubId: string;
  /**
   * The club's MAIN channel, which governs the photos' access.
   *
   * > **A news photo is uploaded against the club's main channel, and that is not a workaround.**
   * > An upload intent for a photo requires a channel because the channel's access rules are what
   * > govern the object, and a news post has none of its own. The main channel is the right governor:
   * > news is readable by every club member and so is the main channel, so the audience is identical.
   * > Inventing a news-shaped branch in the media pipeline would add a second answer to a question
   * > that already has a correct one.
   * >
   * > What the object is FOR is a separate fact, and the post write is what records it: the server
   * > stamps `owner_type = 'news_post'` so these never appear in the chat Gallery (PRD/13 rule 4).
   */
  channelId: string | null;
  /**
   * The post being edited, or null to write a new one.
   *
   * One component for both, which is `PRD/06` rule 7 - "editing reuses the create form,
   * pre-filled" - and the reason the rule is worth obeying rather than forking: everything the
   * composer has learned about cropping, ordering and the six-photo ceiling would otherwise need
   * a second copy that drifts.
   */
  post?: NewsPost | null;
  onCancel: () => void;
  onPosted: () => void;
}) {
  const editing = post ?? null;

  /*
   * Seeded from the post exactly once, by `useState`'s initialiser rather than an effect.
   *
   * An effect would overwrite what somebody had typed on any re-render that changed the post
   * object, which is every reload of the feed behind this screen.
   */
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [aspect, setAspect] = useState<Aspect>(editing?.aspect ?? '1:1');
  const [slots, setSlots] = useState<Slot[]>(() =>
    // Already uploaded, in the post's own order, with no local file. See `Slot.picked`.
    (editing?.mediaIds ?? []).map((mediaId) => ({
      key: `existing-${mediaId}`,
      picked: null,
      mediaId,
      failed: false,
    })),
  );
  const [locationName, setLocationName] = useState(editing?.locationName ?? '');
  const [locationUrl, setLocationUrl] = useState(editing?.locationUrl ?? '');
  const [people, setPeople] = useState<MemberCandidate[]>(
    // `NewsPost.people` and `MemberCandidate` carry the same three fields under the same names.
    (editing?.people ?? []).map((person) => ({
      userId: person.userId,
      name: person.name,
      image: person.image,
    })),
  );
  /*
    Open already when the post arrived with a place, closed when it did not.

    Left at `false` it hid an existing location behind a button reading "Add a location" - the
    value was in state and would have survived the save, so nothing would have been lost, but the
    form showed no sign of a place the post plainly has and offered no way to correct one. A field
    you cannot see is a field you cannot edit, and the button was telling you there was nothing
    there.
  */
  const [placing, setPlacing] = useState((editing?.locationName ?? '') !== '');
  const [naming, setNaming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = slots.filter((slot) => slot.mediaId !== null);
  const uploading = slots.some((slot) => slot.mediaId === null && !slot.failed);

  // A post must have a title, body text, or at least one photo. Enforced here so the button is
  // honest, by the route, and by a deferred trigger so it is true regardless.
  const valid = title.trim().length > 0 || body.trim().length > 0 || ready.length > 0;

  /**
   * Upload one photo, cropped to the post's shape.
   *
   * The rectangle is computed rather than dragged: every photo in a post shares one frame, so
   * there is one right answer per photo and the author has already given it by choosing the
   * shape. The phone chooses the rectangle and the server cuts the pixels, which is
   * `11-photo-compose` rule 3 and the reason nothing here imports a native module.
   */
  const upload = useCallback(
    async (slot: Slot, forAspect: Aspect) => {
      // Already uploaded, and no local original to send. Nothing to do rather than an error.
      if (slot.picked === null) return;
      if (channelId === null) {
        setFailed('This club has no chat channel to attach a photo through.');
        return;
      }
      const picked = slot.picked;
      const source = { width: picked.width, height: picked.height };
      const norm = centredRectForRatio(source, ratioOf(forAspect));
      const crop = source.width > 0 && source.height > 0 ? toSourceRect(norm, source) : undefined;

      try {
        const uploaded = await uploadAttachment(channelId, picked, 'photo', crop);
        setSlots((current) =>
          current.map((entry) =>
            entry.key === slot.key
              ? { ...entry, mediaId: uploaded.mediaId, failed: false }
              : entry,
          ),
        );
      } catch (caught) {
        setSlots((current) =>
          current.map((entry) => (entry.key === slot.key ? { ...entry, failed: true } : entry)),
        );
        setFailed(
          caught instanceof UploadError ? caught.message : 'That photo could not be uploaded.',
        );
      }
    },
    [channelId],
  );

  const add = async () => {
    setFailed(null);
    const room = MAX_PHOTOS - slots.length;
    if (room <= 0) return;

    let picked: PickedPhoto[] = [];
    try {
      picked = await pickPhotos(room);
    } catch (caught) {
      setFailed(caught instanceof UploadError ? caught.message : 'Could not open your photos.');
      return;
    }
    if (picked.length === 0) return;

    const fresh: Slot[] = picked.map((photo) => ({
      key: `${photo.uri}-${Math.random().toString(36).slice(2, 8)}`,
      picked: photo,
      mediaId: null,
      failed: false,
    }));
    setSlots((current) => [...current, ...fresh]);
    // Each on its own, so a slow one does not hold up the rest and a failed one is alone.
    for (const slot of fresh) void upload(slot, aspect);
  };

  /**
   * Changing the shape re-crops rather than refuses (DESIGN/13 rule 5).
   *
   * Somebody who picks four photos and then decides the post is landscape must not have to start
   * again, so every slot is uploaded afresh at the new shape. The old objects are left behind for
   * the nightly sweep, which is the storage gap PRD/13 already records.
   */
  /*
    An edit cannot re-crop what it did not pick, so the shape locks rather than lying.

    The re-crop above works by uploading each slot's LOCAL file again at the new ratio. A photo
    that arrived with the post has no local file - the server holds the already-cut result - so on
    an edit the old photos would keep the old shape while any newly added one took the new shape,
    and the carousel draws every photo in one frame. That is a visibly broken gallery produced by
    a control that appeared to work, which is worse than a control that is plainly unavailable.

    So the shape is fixed for as long as the post's own photos are in the row, and removing them
    all hands it back. Stated in the UI rather than silently ignored - see `shapeLocked`.
  */
  const shapeLocked = slots.some((slot) => slot.picked === null);

  const changeAspect = (next: Aspect) => {
    if (shapeLocked) return;
    setAspect(next);
    if (slots.length === 0) return;
    const reset = slots.map((slot) => ({ ...slot, mediaId: null, failed: false }));
    setSlots(reset);
    for (const slot of reset) void upload(slot, next);
  };

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    const draft = {
      title: title.trim() || null,
      body: body.trim() || null,
      mediaIds: ready.map((slot) => slot.mediaId!),
      aspect,
      locationName: locationName.trim() || null,
      // A link with no name is refused by the server, so it is not offered here either.
      locationUrl: locationName.trim() ? locationUrl.trim() || null : null,
      peopleIds: people.map((person) => person.userId),
    };

    try {
      /*
        One draft, two verbs. `PATCH` takes the whole post rather than a diff, which is why the
        existing photos had to be carried into `slots` as real entries rather than remembered on
        the side: whatever is in the row at this moment IS the post's gallery, and a photo left
        out here is a photo removed. `PRD/06` rule 7's "photos survive an edit that does not touch
        them" is delivered by them still being in the row, not by the server inferring anything.
      */
      if (editing !== null) {
        await contentApi.updateNews(editing.id, draft);
      } else {
        await contentApi.createNews(clubId, draft);
      }
      onPosted();
    } catch {
      setFailed(
        editing !== null
          ? 'Could not save. A post needs a title, some text, or a photo.'
          : 'Could not post. A post needs a title, some text, or a photo.',
      );
    } finally {
      setBusy(false);
    }
  };

  /*
    The header arrow belongs to the LAYOUT, which builds it per route - and this route is three
    screens wearing one url: the feed, this composer, and the picker. Left alone, the arrow
    unwinds the whole route from any of them, which is what was reported from the phone.

    So each step claims the header while it is showing, and the swipe-back gesture is off for
    both: a swipe cannot be redirected the way a press can, so allowing it would leave exactly
    the bug this fixes, reachable by dragging instead of tapping.
  */
  if (naming) {
    return (
      <>
        <Stack.Screen
          options={{
            // Back out of the picker is a CANCEL: `Done` is what applies a selection, so the
            // arrow discards it. Anything else would make `Done` decorative.
            headerLeft: () => <BackStep onPress={() => setNaming(false)} label="the post" />,
            gestureEnabled: false,
          }}
        />
        <PeoplePicker
          clubId={clubId}
          chosen={people}
          onDone={(next) => {
            setPeople(next);
            setNaming(false);
          }}
        />
      </>
    );
  }

  return (
    <Body>
      <Stack.Screen
        options={{
          // Identical to the Cancel button below it, deliberately: two ways out of a draft that
          // do different things is how somebody loses one.
          headerLeft: () => <BackStep onPress={onCancel} label="News" />,
          gestureEnabled: false,
        }}
      />
      <SectionHeader title={editing !== null ? 'Edit post' : 'New post'} />
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Optional" />
      <Field label="Description" value={body} onChangeText={setBody} multiline />

      <Text style={styles.fieldLabel}>Photos &amp; shape</Text>
      <View style={styles.aspectRow}>
        {ASPECTS.map((entry) => (
          <Pressable
            key={entry.key}
            style={[
              styles.aspectChip,
              aspect === entry.key && styles.aspectChipOn,
              shapeLocked && aspect !== entry.key && styles.aspectChipOff,
            ]}
            onPress={() => changeAspect(entry.key)}
            disabled={shapeLocked}
            accessibilityRole="radio"
            accessibilityState={{ selected: aspect === entry.key, disabled: shapeLocked }}
            accessibilityLabel={`${entry.label}, ${entry.key}`}
          >
            <Text style={[styles.aspectText, aspect === entry.key && styles.aspectTextOn]}>
              {entry.key}
            </Text>
          </Pressable>
        ))}
      </View>
      {shapeLocked && (
        <Text style={styles.meta}>
          This post's shape is fixed while its photos are here. Remove them to choose another.
        </Text>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow}>
        {/* Add is FIRST and always in the same place, and leaves the row entirely at six. */}
        {slots.length < MAX_PHOTOS && (
          <Pressable
            style={styles.addTile}
            onPress={() => void add()}
            accessibilityRole="button"
            accessibilityLabel="Add photos"
          >
            <Text style={styles.addPlus}>+</Text>
            <Text style={styles.addLabel}>Add</Text>
          </Pressable>
        )}

        {slots.map((slot, index) => (
          <View key={slot.key} style={styles.thumbWrap}>
            {/* Already on the server draws from its id; a fresh pick draws from the local file. */}
            {slot.picked === null && slot.mediaId !== null ? (
              <RemoteImage mediaId={slot.mediaId} style={styles.thumb} resizeMode="cover" />
            ) : (
              <Image
                source={{ uri: slot.picked?.uri ?? '' }}
                style={styles.thumb}
                resizeMode="cover"
              />
            )}
            {slot.mediaId === null && (
              <View style={styles.veil}>
                <Text style={styles.veilText}>{slot.failed ? 'Retry' : '...'}</Text>
              </View>
            )}
            {slot.failed && (
              <Pressable
                style={styles.retry}
                onPress={() => void upload(slot, aspect)}
                accessibilityRole="button"
                accessibilityLabel={`Retry photo ${index + 1}`}
              />
            )}
            {/* A sibling of the thumbnail, never a child: a control inside a pressable is
                swallowed on native and invalid on web. */}
            <Pressable
              style={styles.remove}
              onPress={() => setSlots((current) => current.filter((e) => e.key !== slot.key))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove photo ${index + 1}`}
            >
              <Text style={styles.removeText}>×</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {slots.length >= MAX_PHOTOS && (
        <Text style={styles.meta}>Six photos is the limit for one post.</Text>
      )}

      {placing ? (
        <>
          <Field
            label="Where"
            value={locationName}
            onChangeText={setLocationName}
            placeholder="Lincoln Memorial, Washington DC"
          />
          <Field
            label="Link (optional)"
            value={locationUrl}
            onChangeText={setLocationUrl}
            placeholder="https://"
            keyboardType="url"
          />
        </>
      ) : (
        <Action label="Add a location" variant="secondary" onPress={() => setPlacing(true)} />
      )}

      <Action
        /* A count, not the names. The button uppercases its label, and "TAGGED: MOLLY JESSON
           AND OWEN WENDT" already fills the row at two people - a fifth name would wrap it. The
           names are on the card once it posts, and in the picker before that. */
        label={people.length === 0 ? 'Tag people' : `Tag people (${people.length})`}
        variant="secondary"
        onPress={() => setNaming(true)}
      />

      {/*
        The consequence line differs because the consequence differs: creating tells the club and
        editing tells nobody, except somebody newly named. PRD/06 rule 6.
      */}
      <Text style={styles.meta}>
        {editing !== null
          ? 'A post needs a title, text, or a photo. Saving tells nobody, except anybody you have just named.'
          : 'A post needs a title, text, or a photo. Posting tells every other member of the club.'}
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? (editing !== null ? 'Saving' : 'Posting') : editing !== null ? 'Save' : 'Post'}
          style={styles.actionButton}
          disabled={busy || uploading || !valid}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

/**
 * Who this post names.
 *
 * The same read and the same interaction as adding people to a race roster: the club is listed to
 * be scrolled, and the search box is the way through once it is long. Only members of this club
 * are offered, and only somebody who may post can ask (ADR-0040).
 */
function PeoplePicker({
  clubId,
  chosen,
  onDone,
}: {
  clubId: string;
  chosen: MemberCandidate[];
  onDone: (next: MemberCandidate[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MemberCandidate[]>(chosen);
  const candidates = useLoad(
    () => contentApi.newsMemberCandidates(clubId, query.trim(), 100),
    [clubId, query],
  );

  const selectedIds = useMemo(
    () => new Set(selected.map((person) => person.userId)),
    [selected],
  );

  const toggle = (person: MemberCandidate) => {
    setSelected((current) =>
      current.some((entry) => entry.userId === person.userId)
        ? current.filter((entry) => entry.userId !== person.userId)
        : [...current, person],
    );
  };

  return (
    <View style={styles.flex}>
      {/* `SectionHeader` carries no padding of its own - it expects to sit inside `Body`, which
          this screen deliberately is not, because the list below has to scroll on its own. */}
      <View style={styles.pickerHeader}>
        <SectionHeader title="Tag people" />
      </View>
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search this club"
          placeholderTextColor={color.textSecondary}
          autoCapitalize="none"
          accessibilityLabel="Search club members"
        />
      </View>

      <DataScreen
        load={candidates}
        isEmpty={(data) => data.candidates.length === 0}
        empty={<EmptyState title="Nobody to tag" body="Only members of this club can be named." />}
      >
        {(data) => (
          <FlatList
            data={data.candidates}
            keyExtractor={(person) => person.userId}
            renderItem={({ item }) => (
              <Pressable
                style={styles.personRow}
                onPress={() => toggle(item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selectedIds.has(item.userId) }}
                accessibilityLabel={item.name}
              >
                <Avatar name={item.name} image={item.image} size={32} />
                <Text style={styles.personName}>{item.name}</Text>
                {selectedIds.has(item.userId) && <Text style={styles.tick}>✓</Text>}
              </Pressable>
            )}
          />
        )}
      </DataScreen>

      <View style={styles.footer}>
        <Action label={`Done (${selected.length})`} onPress={() => onDone(selected)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  searchInput: {
    flex: 1,
    ...type.body,
    color: color.textPrimary,
    backgroundColor: color.appBackground,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  searchClear: { ...type.bodySmall, color: color.accent },

  author: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  authorText: { flex: 1, gap: space.xs },
  name: { ...type.headline, color: color.textPrimary },
  title: { ...type.headline, color: color.textPrimary },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  people: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  fieldLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' as const },

  photo: { width: '100%', borderRadius: radius.sm, backgroundColor: color.fallback },
  counter: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: '#00000099',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  counterText: { ...type.bodySmall, color: '#ffffff' },
  dots: {
    position: 'absolute',
    bottom: space.sm,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xs,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#ffffff80' },
  dotOn: { backgroundColor: '#ffffff' },

  locationRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  location: { ...type.bodySmall, color: color.textSecondary },
  locationLink: { ...type.bodySmall, color: color.accent },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tagChip: {
    backgroundColor: color.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  tagText: { ...type.bodySmall, color: color.onAccentSoft },

  reactions: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap', alignItems: 'center' },
  pill: {
    borderWidth: 1,
    borderColor: color.divider,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  pillMine: { borderColor: color.accent, backgroundColor: color.accentSoft },
  pillText: { ...type.bodySmall, color: color.textPrimary },
  addReaction: {
    borderWidth: 1,
    borderColor: color.divider,
    borderRadius: radius.pill,
    width: 32,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addReactionText: { ...type.body, color: color.textSecondary },

  aspectRow: { flexDirection: 'row', gap: space.xs },
  aspectChip: {
    borderWidth: 1,
    borderColor: color.divider,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  aspectChipOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  /** The shapes not chosen, while the shape is locked: present, legibly unavailable. */
  aspectChipOff: { opacity: 0.4 },
  /*
    Absolutely positioned so the author row below stays centred on the CARD rather than on
    whatever width is left beside a button - the same reason the member card's "..." floats.
    `zIndex` because it is declared before the content it must sit above.
  */
  cardMenuHost: { position: 'absolute', top: space.xs, right: space.xs, zIndex: 2 },
  cardMenuButton: { padding: space.xs },
  aspectText: { ...type.bodySmall, color: color.textSecondary },
  aspectTextOn: { color: color.onAccentSoft },

  photoRow: { flexGrow: 0 },
  addTile: {
    width: 96,
    height: 96,
    marginRight: space.sm,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: { ...type.headline, color: color.accent },
  addLabel: { ...type.bodySmall, color: color.accent },
  thumbWrap: { width: 96, height: 96, marginRight: space.sm },
  thumb: { width: 96, height: 96, borderRadius: radius.sm, backgroundColor: color.fallback },
  veil: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#00000066',
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  veilText: { ...type.bodySmall, color: '#ffffff' },
  retry: { ...StyleSheet.absoluteFill, borderRadius: radius.sm },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#000000cc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { color: '#ffffff', fontSize: 16, lineHeight: 18 },

  pickerHeader: { paddingHorizontal: space.md },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  personName: { ...type.body, color: color.textPrimary, flex: 1 },
  tick: { ...type.body, color: color.accent },

  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
