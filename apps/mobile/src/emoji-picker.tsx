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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
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
import { useRisingSheet } from './ui.tsx';

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

/**
 * How tall a heading is, in points, derived from the style rather than guessed at.
 *
 * `type.label` carries an explicit `lineHeight`, and the two margins are tokens, so this is the
 * real number rather than an estimate - and the heading is always one line, because the titles
 * are two words at most. It is a constant so that `getItemLayout` and the style cannot disagree;
 * see `styles.heading`, which states the same height rather than letting text decide it.
 */
const HEADING_HEIGHT = type.label.lineHeight + space.md + space.xs;

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
  /** The list's own width, which is what an emoji row's height is a seventh of. */
  const [listWidth, setListWidth] = useState(0);
  /*
   * A heading's full footprint, taken from the first one drawn rather than trusted from the
   * constant. `HEADING_HEIGHT` is right until somebody turns up the system font size, which
   * scales the line and would put every offset below it slightly out.
   */
  const [headingHeight, setHeadingHeight] = useState(HEADING_HEIGHT);
  const insets = useSafeAreaInsets();

  /*
   * The entrance and the exit, from the hook every other panel in the app uses.
   *
   * > **This used to be `animationType="slide"` on the Modal, and that slides the SCRIM TOO.**
   *   The founder reported it from his phone on 2026-08-14 pointing at WhatsApp: "i dont want the
   *   shade explicitly shown sliding". What you saw was a grey block travelling up and down the
   *   screen with the panel, with a hard edge across the middle of the conversation - the panel
   *   and the dimming are one view to the platform animation, so it moves both.
   *
   * The reactions sheet learned this on 2026-08-13 and the member card on 2026-08-14; this is the
   * third and last surface that had it. `useRisingSheet` dims in place and moves only the panel.
   */
  const picked = useRef<string | null>(null);
  const finish = useCallback(() => {
    const chosen = picked.current;
    if (chosen === null) onDismiss();
    else onPick(chosen);
  }, [onDismiss, onPick]);
  const { dim, rise, sheetHeight, setSheetHeight, close } = useRisingSheet(finish);

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

  /*
   * Where every row starts, in points. A running total over `rows`, which is the whole reason the
   * jump can be exact.
   *
   * > **The picker used to walk to a category instead of going there, and this is why.** The jump
   * > was `scrollToIndex` on a row virtualization had never measured, so `onScrollToIndexFailed`
   * > fired and guessed an offset from `averageItemLength` - an average of two DIFFERENT heights,
   * > a heading and an emoji row, so it was never right. The guess landed mid-list, which rendered
   * > rows, which fired `onViewableItemsChanged`, which lit whichever category had just appeared;
   * > then the retry failed again, guessed again, landed again. Tapping Flags visibly stepped
   * > through every category on the way down. Reported from the phone on 2026-08-15: "it start
   * > clicking every category and then it reaches it".
   * >
   * > Both heights are knowable, so nothing has to be guessed. A heading is `HEADING_HEIGHT`; an
   * > emoji row is one seventh of the list's own width, measured rather than assumed and ROUNDED,
   * > so that a couple of hundred rows cannot accumulate a fraction of a point each into a visible
   * > drift.
   */
  const rowHeight = listWidth === 0 ? 0 : Math.round(listWidth / PER_ROW);
  const offsets = useMemo(() => {
    const table: number[] = [];
    let running = 0;
    for (const row of rows) {
      table.push(running);
      running += row.kind === 'heading' ? headingHeight : rowHeight;
    }
    return table;
  }, [rows, rowHeight, headingHeight]);

  const jumpTo = (groupKey: string) => {
    const index = headingIndex.get(`h-${groupKey}`);
    const offset = offsets[index ?? -1];
    if (index === undefined || offset === undefined) return;
    // Set immediately rather than waiting for the scroll to report back: the button must light up
    // under the finger, not a frame after the list settles.
    setActiveGroup(groupKey);
    /*
     * `scrollToOffset` with a distance we computed, never `scrollToIndex`. The index form has to
     * ask the list where that row is and cannot answer for a row it has not rendered; this form
     * has nothing to look up and nothing to fail at, so there is no retry and nothing to watch.
     */
    listRef.current?.scrollToOffset({ offset, animated: false });
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
    // Handed over at the END of the exit rather than immediately, so the panel leaves the way it
    // arrived instead of being unmounted mid-screen by the parent.
    picked.current = emoji;
    close();
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <View style={styles.backdrop}>
        {/*
          The dimming, as its own layer rather than a colour on the backdrop. It has to be able to
          fade on its own: the panel travels and the shade does not, and the two sharing one view
          is exactly what made the shade slide up and down the screen with it.
        */}
        <Animated.View
          style={[styles.scrim, { opacity: dim }]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        {/*
          The dismiss target is a sibling filling the screen, never a wrapper: a Pressable around
          the sheet would put every emoji inside another press target, which is failure mode 17.
        */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close the emoji picker"
        />
        <Animated.View
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[
            styles.sheet,
            {
              // Hidden until measured, so it never shows at its resting place for the one frame
              // before the animation knows how far it has to travel.
              opacity: sheetHeight === 0 ? 0 : 1,
              transform: [
                {
                  translateY: rise.interpolate({
                    inputRange: [0, 1],
                    outputRange: [sheetHeight, 0],
                  }),
                },
              ],
            },
          ]}
        >
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
              onPress={close}
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
            // One seventh of this is an emoji row's height, and it is the only measurement the
            // list's arithmetic needs.
            onLayout={(event) => setListWidth(event.nativeEvent.layout.width)}
            /*
              Rows are two heights rather than variable ones, and both are known: a heading is a
              constant, an emoji row is a seventh of the width above. So the list is told where
              every row is rather than being asked to find out, which is what makes a jump land in
              one movement. This replaced an `onScrollToIndexFailed` that guessed from an average
              of the two heights, retried, guessed again, and visibly walked down the list.
            */
            getItemLayout={
              rowHeight === 0
                ? undefined
                : (_data, index) => ({
                    length: rows[index]?.kind === 'heading' ? headingHeight : rowHeight,
                    offset: offsets[index] ?? 0,
                    index,
                  })
            }
            renderItem={({ item }) =>
              item.kind === 'heading' ? (
                <Text
                  style={styles.heading}
                  // What the arithmetic above assumes, checked against what was actually drawn.
                  // The margins are outside the text box and belong to the row's footprint.
                  onLayout={(event) => {
                    const drawn = event.nativeEvent.layout.height + space.md + space.xs;
                    setHeadingHeight((held) => (Math.abs(held - drawn) < 0.5 ? held : drawn));
                  }}
                >
                  {item.title}
                </Text>
              ) : (
                // The height is stated rather than left to `aspectRatio` on the cells, so that the
                // number here and the number `getItemLayout` reports are the same number.
                <View style={[styles.row, { height: rowHeight }]}>
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
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /*
   * No colour on the backdrop itself - the dimming is the layer below, so it can fade while the
   * panel travels. A background here is what made the shade slide with the sheet.
   */
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
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
    A FIXED fraction of the row, never `flex: 1`, and the row owns the height.

    > **`flex: 1` was the first version and it was wrong in a way only a short row shows.** With
    > eight cells it looks perfect; with two search results each cell takes half the width, and
    > `aspectRatio: 1` then makes it half a screen TALL - so "dino" returned two emoji floating in
    > an enormous white gap, and a Recent row holding one emoji was a full-width square. Reported
    > from the phone with both screenshots.

    One seventh regardless of how many are in the row, so a partial row is simply short. The
    height moved from `aspectRatio` here to an explicit height on the row on 2026-08-15, so that
    the height the list is TOLD each row is and the height each row actually takes are one number
    rather than two that agree by arithmetic. A jump lands on the row it names because of it.
  */
  cell: {
    width: `${100 / PER_ROW}%`,
    height: '100%',
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
