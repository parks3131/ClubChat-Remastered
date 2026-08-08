/**
 * A roster: **one implementation, three scopes.**
 *
 * Design-system rule 5. The club roster, a race roster and the Eboard roster are the same screen
 * with different rows, different section titles and a different set of per-row actions - so this
 * takes those as data and knows nothing about which scope it is drawing. There is deliberately no
 * `scope` prop to switch on.
 *
 * ---
 *
 * **Three rules that are easy to lose and expensive to get wrong.**
 *
 *  1. **Every action offered here is refused server-side too.** Hiding a control is UX, not
 *     security. The caller decides what to offer by asking the server what the viewer may do,
 *     never by re-deriving a role rule in the client - a second definition of a permission is how
 *     the two drift apart.
 *  2. **`pendingRequests: null` means "you may not see these", which is not an empty queue.** The
 *     section is absent for a non-admin rather than rendered empty, because an empty "Pending
 *     requests" heading tells a member that a queue exists and is currently empty, which is more
 *     than they are entitled to know.
 *  3. **Opening this screen is what clears that scope's join-request notifications** - not
 *     opening the inbox. That is one of the two exceptions in the notification model, and it
 *     belongs to whichever screen actually deals with the request.
 *
 * The search filters rows already in hand rather than re-reading, so it keeps working offline and
 * costs nothing per keystroke. The **add-member** search is the opposite - it must ask the server,
 * because the whole point is finding somebody who is not on this list yet.
 */

import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { MemberCandidate } from '../api.ts';
import { timeAgo } from '../dates.ts';
import { longPressFeedback } from '../haptics.ts';
import { color, radius, space, type } from '../theme.ts';
import {
  Action,
  Avatar,
  Card,
  ContextMenu,
  EmptyState,
  SearchField,
  measureRow,
  type PressAnchor,
} from '../ui.tsx';
import { MemberPicker } from './member-picker.tsx';

/** One person on a roster, already reduced to what this screen draws. */
export type MemberRow = {
  userId: string;
  name: string;
  /** Their picture. Null - the common case - draws the letter instead, same as everywhere else. */
  image: string | null;
  /** Shown as a tag beside the name. Null draws none. */
  tag: string | null;
  /** Which section this row belongs under. Sections render in the order given to the screen. */
  section: string;
  /** The caller's own row: it gets a lock instead of a menu, and can never be acted on. */
  isSelf: boolean;
};

/** A per-row action, offered only when the caller may actually perform it. */
export type MemberAction = {
  label: string;
  /**
   * The icon beside it in the lifted menu.
   *
   * Optional with a neutral fallback rather than required, so a caller that has not chosen one
   * yet still renders a usable menu instead of a blank square.
   */
  icon?: ComponentProps<typeof MaterialIcons>['name'];
  destructive?: boolean;
  run: (userId: string) => Promise<unknown>;
};

export type PendingRequest = {
  requestId: string;
  userId: string;
  name: string;
  image: string | null;
  requestedAt: string;
};

export function MembersScreen({
  rows,
  sections,
  pendingRequests,
  onDecideRequest,
  actionsFor,
  addPeople,
  emptyTitle,
  profileHref,
  onChanged,
}: {
  rows: readonly MemberRow[];
  /** Section titles in display order. A section with no rows is skipped, never drawn empty. */
  sections: readonly string[];
  /** Null is "you may not see these", which is different from an empty queue. */
  pendingRequests: readonly PendingRequest[] | null;
  onDecideRequest?: (requestId: string, approve: boolean) => Promise<unknown>;
  /**
   * The actions available on one row.
   *
   * A function rather than a flag set, because the answer differs per row: an Owner cannot be
   * removed, an Admin only by the Owner. Returning an empty array means the row gets no menu.
   *
   * **Called for the caller's own row too**, deliberately. Leaving is a real action a member
   * performs on themselves - a race roster offers "Leave this race" there - and a screen that
   * blanket-refused self-actions would have no way to express it. Whether the own row gets a
   * menu is therefore the caller's decision, which is where the rule actually lives.
   */
  actionsFor: (row: MemberRow) => readonly MemberAction[];
  /**
   * How this scope adds people. Absent for a caller who may not, which hides the control.
   *
   * **Two shapes, because the pools are different sizes of thing.** A race or the Eboard draws
   * from one club, which is a list somebody can read down and tick off - so it is shown up
   * front and adds a whole selection at once. The club roster's pool is everybody you share
   * *any* club with, which is not a list anybody browses; it stays type-to-search, one at a
   * time. Making both the same would mean opening the club roster onto a wall of strangers.
   */
  addPeople?:
    | {
        mode: 'search';
        placeholder: string;
        find: (query: string) => Promise<MemberCandidate[]>;
        add: (userId: string) => Promise<unknown>;
      }
    | {
        mode: 'pick';
        placeholder: string;
        /** Called with '' on open to fill the list, then with whatever is typed. */
        find: (query: string) => Promise<MemberCandidate[]>;
        addMany: (userIds: string[]) => Promise<unknown>;
      };
  emptyTitle: string;
  /**
   * Where "View profile" goes, or `null` to not offer it for this row.
   *
   * The club roster passes its own club, because a profile reached from there can offer actions
   * that only make sense inside one - the same person is bannable by you in one club and
   * untouchable in another.
   *
   * > **`null` is load-bearing, not a convenience.** A banned person shares no club with the
   * > viewer any more, and since 2026-08-08 a profile is only readable by somebody you share a
   * > club or a conversation with - so offering the card on a banned row would open a
   * > guaranteed "Not found". The menu omits it instead of shipping a dead end.
   *
   * Optional: the race and Eboard rosters keep the plain card, since neither scope has authority
   * of its own to hand a profile.
   */
  profileHref?: (row: MemberRow) => string | null;
  /** Called after any write, so the caller can re-read the roster it owns. */
  onChanged: () => void;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  /**
   * The row whose menu is open, plus the rectangle it occupies on screen.
   *
   * The rectangle is what lets the menu lift the row rather than slide a sheet up from the
   * bottom, so it is captured at press time and held here beside the row itself - the two are
   * one fact and storing them apart is how a menu ends up drawn against a stale position.
   */
  const [menuFor, setMenuFor] = useState<{ row: MemberRow; anchor: PressAnchor } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** Each row's host view, so the pressed one can be measured. Keyed by the person. */
  const rowViews = useRef(new Map<string, View | null>());

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle.length === 0
      ? rows
      : rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [rows, filter]);

  /** Runs a write, then re-reads. Refuses concurrent writes on the same person. */
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setMenuFor(null);
    try {
      await run();
    } catch {
      // Reload regardless: a refusal may be because the state already changed under us, and the
      // truth is on the server rather than in this component.
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <View style={styles.flex}>
      {/*
        A ScrollView, which this was not.

        > **The roster never scrolled.** `body` was a plain `View` with `flex: 1`, so a list
        > taller than the screen was simply clipped - invisible while every club under test had
        > a handful of members, and reported the moment a Banned section pushed the content past
        > the fold. The footer is in normal flow below this, so the scroller sizes itself against
        > it and the last row clears the Add members button without a hand-tuned bottom padding.

        `keyboardShouldPersistTaps` because the filter field is inside it: without it the first
        tap after typing only dismisses the keyboard and the row underneath is not pressed.
      */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchWrap}>
          <SearchField value={filter} onChangeText={setFilter} placeholder="Search members" />
        </View>

        {/* Absent for a non-admin, never rendered empty. See rule 2 at the top. */}
        {pendingRequests !== null && pendingRequests.length > 0 && (
          <>
            <Text style={styles.section}>Pending requests</Text>
            {pendingRequests.map((request) => (
              <Card key={request.requestId}>
                <View style={styles.person}>
                  <Avatar name={request.name} image={request.image} />
                  <View style={styles.personText}>
                    <Text style={styles.name}>{request.name}</Text>
                    <Text style={styles.meta}>asked {timeAgo(request.requestedAt)}</Text>
                  </View>
                  {busy === request.requestId ? (
                    <ActivityIndicator color={color.accent} />
                  ) : (
                    <View style={styles.decisionRow}>
                      <Pressable
                        style={[styles.decision, styles.deny]}
                        disabled={busy !== null}
                        onPress={() =>
                          void act(request.requestId, () =>
                            onDecideRequest!(request.requestId, false),
                          )
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Deny ${request.name}`}
                      >
                        <MaterialIcons name="close" size={18} color={color.onErrorContainer} />
                      </Pressable>
                      <Pressable
                        style={[styles.decision, styles.approve]}
                        disabled={busy !== null}
                        onPress={() =>
                          void act(request.requestId, () =>
                            onDecideRequest!(request.requestId, true),
                          )
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Approve ${request.name}`}
                      >
                        <MaterialIcons name="check" size={18} color={color.onAccent} />
                      </Pressable>
                    </View>
                  )}
                </View>
              </Card>
            ))}
          </>
        )}

        {visible.length === 0 ? (
          <EmptyState
            title={filter.trim().length > 0 ? 'Nobody by that name' : emptyTitle}
            {...(filter.trim().length > 0 ? { body: 'Try a different search.' } : {})}
          />
        ) : (
          sections.map((section) => {
            const inSection = visible.filter((row) => row.section === section);
            // A section with nobody in it is skipped rather than drawn with a heading and a
            // blank space beneath it.
            if (inSection.length === 0) return null;
            return (
              <View key={section}>
                <Text style={styles.section}>{section}</Text>
                {inSection.map((row) => {
                  const actions = actionsFor(row);
                  return (
                    /*
                      A View, with TWO SIBLING pressables inside it - never a pressable wrapping
                      another. A row that was itself pressable put a <button> inside a <button> on
                      web and swallowed the menu's gesture on native, which is failure mode 17 and
                      is exactly what shipped here on the first pass. v1 has the same shape for the
                      same reason: the name area opens the profile, the menu button opens the menu,
                      and neither contains the other.
                    */
                    /*
                      ONE pressable for the whole row, which is both simpler and safer than the
                      two siblings this used to be. Tap opens the profile; long press lifts the
                      row and opens the menu, the same gesture the chat list and the club hub use.
                      Nothing is nested inside it, so failure mode 17 - a pressable inside a
                      pressable, invalid on web and gesture-swallowing on native - cannot recur.
                    */
                    <Pressable
                      key={row.userId}
                      ref={(view) => {
                        rowViews.current.set(row.userId, view as unknown as View | null);
                      }}
                      style={styles.row}
                      onPress={() => {
                        const href = profileHref?.(row) ?? `/users/${row.userId}`;
                        if (profileHref !== undefined && profileHref(row) === null) return;
                        router.push(href);
                      }}
                      onLongPress={(event) => {
                        if (actions.length === 0) return;
                        // The same buzz every other long press in the app gives, from the one
                        // place that decides how it feels.
                        longPressFeedback();
                        measureRow(
                          rowViews.current.get(row.userId) ?? null,
                          { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
                          (anchor) => setMenuFor({ row, anchor }),
                        );
                      }}
                      delayLongPress={280}
                      accessibilityRole="button"
                      accessibilityLabel={
                        actions.length > 0
                          ? `${row.name}. Open profile, or long press for options`
                          : `Open ${row.name}'s profile`
                      }
                    >
                      <Avatar name={row.name} image={row.image} />
                      <View style={styles.personText}>
                        <Text style={styles.name}>{row.name}</Text>
                        {row.tag !== null && <Text style={styles.tag}>{row.tag}</Text>}
                      </View>
                      {row.isSelf && <Text style={styles.you}>You</Text>}
                      {busy === row.userId && <ActivityIndicator color={color.accent} />}
                      {!row.isSelf && busy !== row.userId && actions.length === 0 && (
                        // A row with nothing to do to it gets a lock rather than a blank gap,
                        // so "no menu here" reads as deliberate rather than as a missing control.
                        <MaterialIcons
                          name="lock"
                          size={16}
                          color={color.divider}
                          accessibilityElementsHidden
                          importantForAccessibility="no"
                        />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            );
          })
        )}
      </ScrollView>

      {addPeople !== undefined && !adding && (
        <View style={styles.footer}>
          <Action label="Add members" onPress={() => setAdding(true)} />
        </View>
      )}

      {addPeople !== undefined && adding && addPeople.mode === 'search' && (
        <AddMembers
          config={addPeople}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {addPeople !== undefined && adding && addPeople.mode === 'pick' && (
        <PickMembers
          config={addPeople}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {/*
        The lifted menu: the row rises, the screen blurs behind it, the menu springs in.

        > **A popover rather than a bottom sheet, and the same one the chat list and the club hub
        > already use.** One gesture should have one feel everywhere, and a roster that answered a
        > long press with a sheet sliding up from the bottom while the identical press on the
        > Chats tab lifted the row would be two controls wearing one gesture.

        The preview is the row redrawn rather than described a second time, so the floating copy
        cannot drift from the real one the next time a row grows a tag.
      */}
      {menuFor !== null && (
        <ContextMenu
          anchor={menuFor.anchor}
          onDismiss={() => setMenuFor(null)}
          preview={
            <View style={styles.row}>
              <Avatar name={menuFor.row.name} image={menuFor.row.image} />
              <View style={styles.personText}>
                <Text style={styles.name}>{menuFor.row.name}</Text>
                {menuFor.row.tag !== null && (
                  <Text style={styles.tag}>{menuFor.row.tag}</Text>
                )}
              </View>
            </View>
          }
          items={[
            // Omitted entirely when the caller says this row has no reachable profile, rather
            // than offered and landing on "Not found". See `profileHref`.
            ...(profileHref !== undefined && profileHref(menuFor.row) === null
              ? []
              : [
                  {
                    label: 'View profile',
                    icon: 'person' as const,
                    onPress: () => {
                      const href =
                        profileHref?.(menuFor.row) ?? `/users/${menuFor.row.userId}`;
                      setMenuFor(null);
                      router.push(href);
                    },
                  },
                ]),
            ...actionsFor(menuFor.row).map((action) => ({
              label: action.label,
              // A neutral fallback, so a caller that has not chosen an icon still gets a menu
              // that reads rather than a row of blanks.
              icon: action.icon ?? ('chevron-right' as const),
              ...(action.destructive === true ? { destructive: true } : {}),
              onPress: () =>
                void act(menuFor.row.userId, () => action.run(menuFor.row.userId)),
            })),
          ]}
        />
      )}
    </View>
  );
}

/**
 * The add-member search.
 *
 * **This one has to ask the server**, unlike the filter above it: the whole point is finding
 * somebody who is not on this roster, so there is nothing local to search. Debounced, and it
 * refuses to query on one character - a single letter matches most of a club and tells the
 * searcher nothing.
 */
function AddMembers({
  config,
  onClose,
  onAdded,
}: {
  config: {
    placeholder: string;
    find: (query: string) => Promise<MemberCandidate[]>;
    add: (userId: string) => Promise<unknown>;
  };
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    // Debounced, and every in-flight result is discarded if the query moved on - otherwise a
    // slow response for "al" can land after a fast one for "alex" and overwrite it.
    let live = true;
    const timer = setTimeout(() => {
      config
        .find(trimmed)
        .then((found) => {
          if (live) setResults(found);
        })
        .catch(() => {
          if (live) setResults([]);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, config]);

  return (
    <View style={styles.addPanel}>
      <View style={styles.addHead}>
        <Text style={styles.addTitle}>Add members</Text>
        <Pressable
          onPress={onClose}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel="Close the add-member search"
        >
          <MaterialIcons name="close" size={22} color={color.textPrimary} />
        </Pressable>
      </View>

      <SearchField value={query} onChangeText={setQuery} placeholder={config.placeholder} />

      {searching && <ActivityIndicator style={styles.addSpinner} color={color.accent} />}

      {!searching && query.trim().length >= 2 && results.length === 0 && (
        // Says what the pool actually is, rather than implying the person does not exist.
        <Text style={styles.meta}>
          Nobody here by that name. You can only add people you already share a club with - send
          anybody else the invite link instead.
        </Text>
      )}

      {results.map((candidate) => (
        <Pressable
          key={candidate.userId}
          style={styles.addResult}
          disabled={busy !== null}
          onPress={() => {
            setBusy(candidate.userId);
            void config
              .add(candidate.userId)
              .then(onAdded)
              .catch(() => setBusy(null));
          }}
          accessibilityRole="button"
          accessibilityLabel={`Add ${candidate.name}`}
        >
          <Avatar name={candidate.name} image={candidate.image} size={32} />
          <Text style={styles.name}>{candidate.name}</Text>
          {busy === candidate.userId && <ActivityIndicator color={color.accent} />}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Pick several people at once.
 *
 * The pool is shown **before anything is typed**, because for a race or the Eboard it is one
 * club's worth of people - a list you read down and tick off, not a haystack you interrogate.
 * Searching narrows the same list rather than being the only way to see any of it.
 *
 * **Selection is held apart from the visible list**, in `chosen`, and that is the detail that
 * makes searching and selecting work together: pick two people, type a name to find a third,
 * and the first two are still selected even though they are no longer on screen. A component
 * that tracked selection as a flag on the current results would silently drop them.
 */
function PickMembers({
  config,
  onClose,
  onAdded,
}: {
  config: {
    placeholder: string;
    find: (query: string) => Promise<MemberCandidate[]>;
    addMany: (userIds: string[]) => Promise<unknown>;
  };
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<MemberCandidate[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    setLoading(true);
    // Debounced, and every in-flight result is discarded if the query moved on - otherwise a
    // slow response for "al" can land after a fast one for "alex" and overwrite it. The empty
    // query is the initial load and is not debounced away, it simply runs with the others.
    let live = true;
    const timer = setTimeout(
      () => {
        config
          .find(trimmed)
          .then((found) => {
            if (live) setResults(found);
          })
          .catch(() => {
            if (live) setResults([]);
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      trimmed.length === 0 ? 0 : 300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, config]);

  const chosenIds = useMemo(() => new Set(chosen.map((c) => c.userId)), [chosen]);

  const toggle = (candidate: MemberCandidate) => {
    setChosen((current) =>
      current.some((c) => c.userId === candidate.userId)
        ? current.filter((c) => c.userId !== candidate.userId)
        : [...current, candidate],
    );
  };

  return (
    <View style={styles.addPanel}>
      <View style={styles.addHead}>
        <Text style={styles.addTitle}>
          {chosen.length === 0 ? 'Add members' : `${chosen.length} selected`}
        </Text>
        <Pressable
          onPress={onClose}
          hitSlop={space.sm}
          accessibilityRole="button"
          accessibilityLabel="Close the add-member list"
        >
          <MaterialIcons name="close" size={22} color={color.textPrimary} />
        </Pressable>
      </View>

      <SearchField value={query} onChangeText={setQuery} placeholder={config.placeholder} />

      <MemberPicker
        candidates={results}
        selectedIds={chosenIds}
        onToggle={toggle}
        loading={loading}
        disabled={saving}
        emptyText={
          query.trim().length > 0
            ? 'Nobody here by that name.'
            : 'Everybody eligible is already here.'
        }
      />

      <Action
        label={saving ? 'Adding...' : chosen.length === 0 ? 'Add' : `Add ${chosen.length}`}
        disabled={chosen.length === 0 || saving}
        onPress={() => {
          setSaving(true);
          void config
            .addMany(chosen.map((c) => c.userId))
            .then(onAdded)
            // The roster is re-read either way by the caller, so a refusal ends up showing the
            // truth rather than this component's guess at it.
            .catch(() => setSaving(false));
        }}
        accessibilityLabel={`Add ${chosen.length} selected ${chosen.length === 1 ? 'person' : 'people'}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { flex: 1 },
  bodyContent: { padding: space.md, gap: space.sm, paddingBottom: space.lg },
  searchWrap: { paddingBottom: space.xs },

  section: {
    ...type.numeric,
    fontSize: 13,
    color: color.textSecondary,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.sm + 4,
    marginBottom: space.xs,
  },
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  personText: { flex: 1, gap: 2 },
  name: { ...type.headline, color: color.textPrimary },
  tag: { ...type.label, color: color.accent, textTransform: 'none' },
  you: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  meta: { ...type.bodySmall, color: color.textSecondary },

  decisionRow: { flexDirection: 'row', gap: space.sm },
  decision: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deny: { backgroundColor: color.errorContainer },
  approve: { backgroundColor: color.accent },

  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  addPanel: {
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
    padding: space.md,
    gap: space.sm,
  },
  addHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  addSpinner: { paddingVertical: space.sm },
  addResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.sm + 4,
  },

});
