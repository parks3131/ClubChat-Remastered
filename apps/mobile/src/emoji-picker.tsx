/**
 * The full emoji picker, behind the `+` on the reaction bar.
 *
 * `PRD/05` rule R1. The set is the catalog - see ADR-0028 - which is bundled rather than fetched:
 * this app has a working offline mode, and a picker that needed the network to open would be the
 * only part of it that did. Search has to be instant for the same reason it has to be local.
 *
 * **Rows of eight, in a `FlatList`.** 1,914 emoji is a real list; rendering them as one column of
 * `Text` nodes drops frames on a phone the moment the sheet opens. Grouping into rows first turns
 * it into ~240 rows, which virtualises properly.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emojiCatalog, type CatalogEmoji } from '@clubchat/shared';
import { color, radius, space, type } from './theme.ts';

/**
 * Emoji per row.
 *
 * Seven, founder-set, matching the system keyboard he compared against - and it is the number
 * that decides how big each emoji is, since a cell is one seventh of the sheet's width.
 */
const PER_ROW = 7;
/** How many recents to keep. Two rows: enough to be useful, short enough to stay recent. */
const MAX_RECENTS = 16;

const RECENTS_KEY = 'clubchat.emoji.recents';

/*
 * Recents live on the device, not the account.
 *
 * The same platform split `session.ts` uses, and for the same reason - there is no web
 * SecureStore. This is not a credential, but it is small, per-device and nobody else's business,
 * and reusing the pattern beats adding a storage dependency for sixteen emoji.
 */
async function loadRecents(): Promise<string[]> {
  try {
    const raw =
      Platform.OS === 'web'
        ? (globalThis.localStorage?.getItem(RECENTS_KEY) ?? null)
        : await SecureStore.getItemAsync(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything else in there is not worth a crash: an unreadable preference is no preference.
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

async function saveRecent(emoji: string): Promise<string[]> {
  const next = [emoji, ...(await loadRecents()).filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
  const raw = JSON.stringify(next);
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(RECENTS_KEY, raw);
    else await SecureStore.setItemAsync(RECENTS_KEY, raw);
  } catch {
    // A preference that will not persist is not worth failing a reaction over.
  }
  return next;
}

/** The recents section's own key, so it can be a category like any other. */
const RECENT = 'recent';

/**
 * Section headings, in the order the picker shows them, each with the icon that stands for it.
 *
 * **Line icons rather than emoji**, matching the system keyboard the founder pointed at: a row of
 * colourful glyphs competes with the grid of colourful glyphs above it, and the eye cannot tell
 * the navigation from the content. Monochrome recedes, which is what a control under a wall of
 * emoji has to do.
 *
 * Keys are the dataset's own, except `recent`, which is ours.
 */
const GROUPS: Array<{
  key: string;
  title: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
}> = [
  { key: RECENT, title: 'Recent', icon: 'schedule' },
  { key: 'smileys-emotion', title: 'Smileys & emotion', icon: 'sentiment-satisfied-alt' },
  { key: 'people-body', title: 'People & body', icon: 'emoji-people' },
  { key: 'animals-nature', title: 'Animals & nature', icon: 'pets' },
  { key: 'food-drink', title: 'Food & drink', icon: 'local-cafe' },
  { key: 'activities', title: 'Activities', icon: 'sports-soccer' },
  { key: 'travel-places', title: 'Travel & places', icon: 'directions-car' },
  { key: 'objects', title: 'Objects', icon: 'lightbulb' },
  { key: 'symbols', title: 'Symbols', icon: 'tag' },
  { key: 'flags', title: 'Flags', icon: 'outlined-flag' },
];

/** Every row carries its `group`, which is how the strip below knows which one to light up. */
type Row =
  | { kind: 'heading'; key: string; group: string; title: string }
  | { kind: 'emoji'; key: string; group: string; items: CatalogEmoji[] };

/** Break a run of emoji into rows of `PER_ROW`, which is what makes the list virtualisable. */
function toRows(group: string, items: readonly CatalogEmoji[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < items.length; i += PER_ROW) {
    rows.push({ kind: 'emoji', key: `${group}-${i}`, group, items: items.slice(i, i + PER_ROW) });
  }
  return rows;
}

/*
 * Stable, because React Native refuses a `viewabilityConfig` that changes between renders - and
 * an inline object is a new one every time.
 */
const VIEWABILITY = { itemVisiblePercentThreshold: 1 } as const;

export function EmojiPicker({
  onPick,
  onDismiss,
}: {
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}) {
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const listRef = useRef<FlatList<Row>>(null);
  const [activeGroup, setActiveGroup] = useState<string>(GROUPS[1]!.key);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    void loadRecents().then(setRecents);
  }, []);

  const byEmoji = useMemo(() => new Map(emojiCatalog.map((e) => [e.emoji, e])), []);

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();

    if (needle.length > 0) {
      /*
       * Label first, then tags, and the tags are why this is worth having: the dataset lists
       * "lol", "lmao" and "haha" against the crying-laughing face, so somebody typing what they
       * mean finds it rather than having to know it is called "face with tears of joy".
       */
      const hits = emojiCatalog.filter(
        (e) => e.label.includes(needle) || e.tags.some((t) => t.includes(needle)),
      );
      return hits.length === 0
        ? [{ kind: 'heading', key: 'none', group: 'q', title: `Nothing matches "${query.trim()}"` }]
        : toRows('q', hits);
    }

    const out: Row[] = [];
    for (const group of GROUPS) {
      const items =
        group.key === RECENT
          ? recents.map((e) => byEmoji.get(e)).filter((e): e is CatalogEmoji => e !== undefined)
          : emojiCatalog.filter((e) => e.group === group.key);
      // A category with nothing in it is skipped rather than shown empty - which today means
      // Recent, until somebody has picked something.
      if (items.length === 0) continue;
      out.push(
        { kind: 'heading', key: `h-${group.key}`, group: group.key, title: group.title },
        ...toRows(group.key, items),
      );
    }
    return out;
  }, [query, recents, byEmoji]);

  /** Where each category's heading sits in `rows`, so a tap can jump straight to it. */
  const headingIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === 'heading') map.set(row.key, index);
    });
    return map;
  }, [rows]);

  const jumpTo = (groupKey: string) => {
    const index = headingIndex.get(`h-${groupKey}`);
    if (index === undefined) return;
    // Set immediately rather than waiting for the scroll to report back: the button must light up
    // under the finger, not a frame after the list settles.
    setActiveGroup(groupKey);
    listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
  };

  /*
   * Which category the reader is actually looking at, from the topmost visible row.
   *
   * `useRef` for the handler because React Native captures the FIRST one it is given and warns if
   * it changes - a fresh closure every render is the usual way to trip that.
   */
  const onViewable = useRef(({ viewableItems }: { viewableItems: Array<{ item: Row }> }) => {
    const first = viewableItems[0]?.item;
    if (first !== undefined) setActiveGroup(first.group);
  }).current;

  const pick = (emoji: string) => {
    // Remembered before the sheet closes, so the next open already has it at the front.
    void saveRecent(emoji);
    onPick(emoji);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        {/*
          The scrim is a sibling filling the screen, never a wrapper: a Pressable around the
          sheet would put every emoji inside another press target, which is failure mode 17.
        */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close the emoji picker"
        />
        <View style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.search}>
              <MaterialIcons name="search" size={18} color={color.textSecondary} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search emoji"
                placeholderTextColor={color.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Search emoji"
              />
            </View>
            <Pressable
              onPress={onDismiss}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <MaterialIcons name="close" size={22} color={color.textPrimary} />
            </Pressable>
          </View>

          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => row.key}
            keyboardShouldPersistTaps="handled"
            onViewableItemsChanged={onViewable}
            viewabilityConfig={VIEWABILITY}
            /*
              Rows are variable height - a heading is not an emoji row - so `scrollToIndex` can
              land beyond what has been measured. Rather than declare a `getItemLayout` that would
              be a lie, jump roughly there and let the list settle, then ask again.
            */
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({
                offset: info.averageItemLength * info.index,
                animated: false,
              });
              setTimeout(() => {
                listRef.current?.scrollToIndex({
                  index: info.index,
                  viewPosition: 0,
                  animated: false,
                });
              }, 60);
            }}
            renderItem={({ item }) =>
              item.kind === 'heading' ? (
                <Text style={styles.heading}>{item.title}</Text>
              ) : (
                <View style={styles.row}>
                  {item.items.map((e) => (
                    <Pressable
                      key={e.emoji}
                      style={styles.cell}
                      onPress={() => pick(e.emoji)}
                      accessibilityRole="button"
                      // The label, not the emoji: a screen reader saying "face with tears of
                      // joy" is useful where saying the character itself is not.
                      accessibilityLabel={e.label}
                    >
                      <Text style={styles.glyph}>{e.emoji}</Text>
                    </Pressable>
                  ))}
                </View>
              )
            }
          />

          {/*
            Jumping between categories, which is what makes 1,914 emoji navigable rather than a
            single scroll. Hidden while searching: the results are one list with no categories in
            it, so the strip would be a control that does nothing.
          */}
          {query.trim().length === 0 && (
            /*
              Lifted clear of the home indicator.

              The sheet is anchored to the bottom of the screen, so without this the strip sits in
              the gesture area - reachable in theory and awkward in practice, which is how it was
              reported: "hard to click at bottom". The inset is taken rather than assumed, since a
              phone without an indicator should not carry the gap.
            */
            <View style={[styles.categories, { paddingBottom: insets.bottom + space.sm }]}>
              {GROUPS.filter((group) => headingIndex.has(`h-${group.key}`)).map((group) => {
                const active = group.key === activeGroup;
                return (
                  <Pressable
                    key={group.key}
                    style={[styles.categoryButton, active && styles.categoryOn]}
                    onPress={() => jumpTo(group.key)}
                    hitSlop={space.sm}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Jump to ${group.title}`}
                  >
                    <MaterialIcons
                      name={group.icon}
                      size={20}
                      color={active ? color.textPrimary : color.textSecondary}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    height: '70%',
    backgroundColor: color.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingBottom: space.sm },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.cardSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  searchInput: { ...type.body, flex: 1, color: color.textPrimary },
  heading: {
    ...type.label,
    color: color.textSecondary,
    textTransform: 'uppercase',
    marginTop: space.md,
    marginBottom: space.xs,
  },
  row: { flexDirection: 'row' },
  /*
    A FIXED fraction of the row, never `flex: 1`.

    > **`flex: 1` was the first version and it was wrong in a way only a short row shows.** With
    > eight cells it looks perfect; with two search results each cell takes half the width, and
    > `aspectRatio: 1` then makes it half a screen TALL - so "dino" returned two emoji floating in
    > an enormous white gap, and a Recent row holding one emoji was a full-width square. Reported
    > from the phone with both screenshots.

    One eighth regardless of how many are in the row, so a partial row is simply short.
  */
  cell: {
    width: `${100 / PER_ROW}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 28, lineHeight: 34 },

  categories: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: color.divider,
    paddingTop: space.sm,
  },
  /*
    A circle under the active one, as the system keyboard does it.

    The padding is bounded by arithmetic rather than taste: ten buttons have to fit the sheet's
    content width, which is the screen less two gutters. At `space.sm + 2` each button was 40pt
    wide, ten came to 400, and the flag fell off the right edge on a 402pt phone. `hitSlop` buys
    back the touch area the smaller padding gives up.
  */
  categoryButton: { padding: space.sm - 2, borderRadius: radius.pill },
  categoryOn: { backgroundColor: color.cardSunken },
});
