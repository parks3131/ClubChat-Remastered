/**
 * Choosing several people at once.
 *
 * **The pool is shown before anything is typed.** That is the whole point of it: for a race or
 * the Eboard the candidates are one club's worth of people, which is a list somebody reads down
 * and ticks off, not a haystack they interrogate a name at a time. Searching narrows the list
 * rather than being the only way to see any of it.
 *
 * Purely presentational, and controlled. It takes the candidates it should draw and the ids
 * currently chosen, and reports taps - it never fetches. The two screens using it get their
 * pool from opposite places (the race form filters a club roster it already holds; the roster
 * panel asks the server for people who are NOT on the roster yet), and that difference belongs
 * to them rather than to a prop on this.
 *
 * Selection is therefore held by the host, which is what lets it survive a change of query:
 * pick two people, search for a third, and the first two stay chosen even though they have
 * scrolled out of the result set. A picker that tracked selection as a flag on the rows it
 * happened to be drawing would drop them silently.
 */

import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { MemberCandidate } from '../api.ts';
import { color, radius, space, type } from '../theme.ts';
import { Avatar } from '../ui.tsx';

export function MemberPicker({
  candidates,
  selectedIds,
  onToggle,
  loading = false,
  disabled = false,
  emptyText,
}: {
  candidates: readonly MemberCandidate[];
  selectedIds: ReadonlySet<string>;
  onToggle: (candidate: MemberCandidate) => void;
  loading?: boolean;
  /** True while the selection is being saved, so a tap cannot change what is in flight. */
  disabled?: boolean;
  emptyText: string;
}) {
  if (loading) return <ActivityIndicator style={styles.spinner} color={color.accent} />;
  if (candidates.length === 0) return <Text style={styles.meta}>{emptyText}</Text>;

  return (
    <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
      {candidates.map((candidate) => {
        const selected = selectedIds.has(candidate.userId);
        return (
          <Pressable
            key={candidate.userId}
            /*
             * Tinted rather than filled. `accentSoft` exists for exactly this - a surface that
             * is marked rather than shouted - and a screen of selected people drawn in full
             * accent becomes a wall of orange with the names fighting it.
             */
            style={[styles.row, selected && styles.rowSelected]}
            disabled={disabled}
            onPress={() => onToggle(candidate)}
            // A checkbox, not a button: it toggles and it has a state, and a screen reader
            // announcing "button" would give no way to tell what is already chosen.
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled }}
            accessibilityLabel={candidate.name}
          >
            <Avatar name={candidate.name} image={candidate.image} size={32} />
            <Text style={styles.name}>{candidate.name}</Text>
            <MaterialIcons
              name={selected ? 'check-circle' : 'radio-button-unchecked'}
              size={22}
              color={selected ? color.accent : color.hairline}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Bounded rather than flexed. Both hosts put a confirm button underneath, and a list free to
  // grow pushes that button off the bottom of the screen exactly when it is needed.
  list: { maxHeight: 320 },
  spinner: { paddingVertical: space.sm },
  meta: { ...type.bodySmall, color: color.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.sm + 4,
    marginBottom: space.xs,
  },
  rowSelected: { backgroundColor: color.accentSoft, borderColor: color.accentSoftBorder },
  name: { ...type.headline, color: color.textPrimary, flex: 1 },
});
