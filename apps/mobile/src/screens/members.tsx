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

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { MemberCandidate } from '../api.ts';
import { timeAgo } from '../dates.ts';
import { color, radius, space, type } from '../theme.ts';
import { Action, Avatar, Card, EmptyState, SearchField, SheetMenu } from '../ui.tsx';

/** One person on a roster, already reduced to what this screen draws. */
export type MemberRow = {
  userId: string;
  name: string;
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
  destructive?: boolean;
  run: (userId: string) => Promise<unknown>;
};

export type PendingRequest = {
  requestId: string;
  userId: string;
  name: string;
  requestedAt: string;
};

export function MembersScreen({
  rows,
  sections,
  pendingRequests,
  onDecideRequest,
  actionsFor,
  addSearch,
  emptyTitle,
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
  /** Absent for a caller who may not add anybody, which hides the control entirely. */
  addSearch?: {
    placeholder: string;
    find: (query: string) => Promise<MemberCandidate[]>;
    add: (userId: string) => Promise<unknown>;
  };
  emptyTitle: string;
  /** Called after any write, so the caller can re-read the roster it owns. */
  onChanged: () => void;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  const [menuRow, setMenuRow] = useState<MemberRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle.length === 0
      ? rows
      : rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [rows, filter]);

  /** Runs a write, then re-reads. Refuses concurrent writes on the same person. */
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setMenuRow(null);
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
      <View style={styles.body}>
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
                  <Avatar name={request.name} />
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
                    <View key={row.userId} style={styles.row}>
                      <Pressable
                        style={styles.rowInfo}
                        onPress={() => router.push(`/users/${row.userId}`)}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${row.name}'s profile`}
                      >
                        <Avatar name={row.name} />
                        <View style={styles.personText}>
                          <Text style={styles.name}>{row.name}</Text>
                          {row.tag !== null && <Text style={styles.tag}>{row.tag}</Text>}
                        </View>
                      </Pressable>
                      {row.isSelf && <Text style={styles.you}>You</Text>}
                      {busy === row.userId ? (
                        <ActivityIndicator color={color.accent} />
                      ) : actions.length > 0 ? (
                        <Pressable
                          onPress={() => setMenuRow(row)}
                          hitSlop={space.sm}
                          accessibilityRole="button"
                          accessibilityLabel={
                            row.isSelf ? 'Your options' : `Manage ${row.name}`
                          }
                        >
                          <MaterialIcons
                            name="more-vert"
                            size={20}
                            color={color.textSecondary}
                          />
                        </Pressable>
                      ) : (
                        // A row with nothing to do to it gets a lock rather than a blank gap,
                        // so "no menu here" reads as deliberate rather than as a missing control.
                        !row.isSelf && (
                          <MaterialIcons
                            name="lock"
                            size={16}
                            color={color.divider}
                            accessibilityElementsHidden
                            importantForAccessibility="no"
                          />
                        )
                      )}
                    </View>
                  );
                })}
              </View>
            );
          })
        )}
      </View>

      {addSearch !== undefined && !adding && (
        <View style={styles.footer}>
          <Action label="Add members" onPress={() => setAdding(true)} />
        </View>
      )}

      {addSearch !== undefined && adding && (
        <AddMembers
          config={addSearch}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {menuRow !== null && (
        <SheetMenu
          title={menuRow.name}
          onDismiss={() => setMenuRow(null)}
          items={[
            {
              label: 'View profile',
              onPress: () => {
                const target = menuRow.userId;
                setMenuRow(null);
                router.push(`/users/${target}`);
              },
            },
            ...actionsFor(menuRow).map((action) => ({
              label: action.label,
              ...(action.destructive === true ? { destructive: true } : {}),
              onPress: () => void act(menuRow.userId, () => action.run(menuRow.userId)),
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
          <Avatar name={candidate.name} size={32} />
          <Text style={styles.name}>{candidate.name}</Text>
          {busy === candidate.userId && <ActivityIndicator color={color.accent} />}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { flex: 1, padding: space.md, gap: space.sm },
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
  rowInfo: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, flex: 1 },
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
