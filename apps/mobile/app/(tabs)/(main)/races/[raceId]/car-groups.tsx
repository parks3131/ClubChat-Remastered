/**
 * Car Assignments and Groups.
 *
 * **Every race member views this, read-only; only managers create, delete, assign or remove**
 * (`PRD/09` rule 20). A manager with no roster row gets nothing here at all - they manage the
 * roster, not the race - which is the server's answer and the clearest expression of authority not
 * being access.
 *
 * The Incharge rule is the one worth getting right: they **must be a current member of that group**,
 * because the Incharge is the person everyone calls when the car does not show up. A group with no
 * Incharge is a normal state - it is cleared automatically when its holder leaves, and the group
 * persists until an admin names a new one.
 *
 * ---
 *
 * **Three things about this screen are deliberate, and each of them was the other way first.**
 *
 *  1. **Adding somebody is a search, not a list of everybody available.** The first version drew
 *     every unassigned person as a row of buttons, which is a roster dump on a screen whose job is
 *     to answer "where is Priya sitting". The pool is already exactly right - rule 16 is the
 *     server's `unassigned` - so the search filters what is in hand rather than asking per
 *     keystroke, the same way the roster's own filter does.
 *  2. **Who is left over is behind a "Remaining" button, and only a manager gets it.** A manager
 *     filling cars needs the leftovers; a member who wants to know which car they are in does not,
 *     and an always-open list of everybody with no seat is the roster dump again in a different
 *     place.
 *  3. **A member's actions live in a sheet on the row, not as buttons beside every name.** Five
 *     names with "Make Incharge" and "Remove" attached is five rows of chrome around the one thing
 *     the screen is for, which is reading who is in which car.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { raceApi } from '../../../../../src/api.ts';
import type { CarGroup, CarGroupPerson } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Avatar,
  Badge,
  Body,
  Card,
  ConfirmDialog,
  DataScreen,
  EmptyState,
  SearchField,
  SectionHeader,
  SheetMenu,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

type Member = CarGroup['members'][number];

export default function CarGroupsScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const router = useRouter();
  const { userId } = useSession();
  const groups = useLoad(() => raceApi.carGroups(raceId), [raceId]);
  const race = useLoad(() => raceApi.detail(raceId), [raceId]);
  // Inside this club for as long as this screen is mounted. Resolved from the read
  // rather than a param: a race and an Eboard space each know their own club.
  useDeclareRace(
    raceId,
    race.data?.race.clubId,
    race.data?.race.name,
    race.data?.race.image,
  );
  const [busy, setBusy] = useState(false);
  /** The row whose sheet is open. Held here rather than per card: only one sheet exists at a time. */
  const [menu, setMenu] = useState<{ group: CarGroup; member: Member } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CarGroup | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [showRemaining, setShowRemaining] = useState(false);

  const isManager = race.data?.race.viewer.isManager === true;

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setMenu(null);
    setPendingDelete(null);
    try {
      await run();
    } catch {
      // Reload regardless: a refusal is often because the state moved under us, and the truth
      // is on the server rather than in this component.
    } finally {
      setBusy(false);
      groups.reload();
    }
  };

  return (
    <View style={styles.flex}>
      <DataScreen
        load={groups}
        isEmpty={(data) => data.groups.length === 0 && !isManager}
        empty={<EmptyState title="No car groups yet" body="An admin creates and fills them." />}
      >
        {(data) => (
          <Body>
            {data.groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                unassigned={data.unassigned}
                isManager={isManager}
                busy={busy}
                adding={addingTo === group.id}
                onToggleAdd={() => setAddingTo((open) => (open === group.id ? null : group.id))}
                onAssign={(person) => {
                  setAddingTo(null);
                  void act(() => raceApi.assignToCarGroup(group.id, person.userId));
                }}
                onOpenMember={(member) => setMenu({ group, member })}
                onDelete={() => setPendingDelete(group)}
              />
            ))}

            {isManager && (
              <>
                <SectionHeader title="Manage" />
                {/* Auto-numbered, with no naming prompt: naming eight cars is friction. */}
                <Action
                  label="Add a group"
                  disabled={busy}
                  onPress={() => void act(() => raceApi.createCarGroup(raceId))}
                />

                {/*
                  Who still has no seat, folded away. The count is on the button because that is
                  the part a manager reads at a glance - "four people still need a car" - and the
                  names are the part they only need while they are filling one.
                */}
                {data.unassigned.length > 0 && (
                  <>
                    <Action
                      label={
                        showRemaining
                          ? `Hide remaining (${data.unassigned.length})`
                          : `Remaining (${data.unassigned.length})`
                      }
                      variant="quiet"
                      onPress={() => setShowRemaining((open) => !open)}
                      accessibilityLabel={
                        showRemaining
                          ? 'Hide the people with no car'
                          : `Show the ${data.unassigned.length} people with no car`
                      }
                    />
                    {showRemaining && (
                      <Card>
                        {data.unassigned.map((person) => (
                          <PersonRow key={person.userId} person={person} />
                        ))}
                      </Card>
                    )}
                  </>
                )}
              </>
            )}
          </Body>
        )}
      </DataScreen>

      {menu !== null && (
        <SheetMenu
          title={menu.member.name}
          onDismiss={() => setMenu(null)}
          items={memberActions({
            group: menu.group,
            member: menu.member,
            isManager,
            isSelf: menu.member.userId === userId,
            raceId,
            router,
            act,
            dismiss: () => setMenu(null),
          })}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={`Delete Group ${pendingDelete.number}?`}
          body="Everybody in it goes back to having no car. They stay on the race roster, and can be put in another group."
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void act(() => raceApi.deleteCarGroup(pendingDelete.id))}
        />
      )}
    </View>
  );
}

/**
 * What the sheet offers on one person, which is entirely a question of who is looking.
 *
 * **Every one of these is refused server-side too.** Hiding a control is UX, not security - so
 * this decides what to *offer* from the viewer's standing and never re-derives the rule itself.
 */
function memberActions({
  group,
  member,
  isManager,
  isSelf,
  raceId,
  router,
  act,
  dismiss,
}: {
  group: CarGroup;
  member: Member;
  isManager: boolean;
  isSelf: boolean;
  raceId: string;
  router: ReturnType<typeof useRouter>;
  act: (run: () => Promise<unknown>) => Promise<void>;
  dismiss: () => void;
}): Array<{ label: string; onPress: () => void; destructive?: boolean }> {
  const items: Array<{ label: string; onPress: () => void; destructive?: boolean }> = [
    {
      label: 'View profile',
      onPress: () => {
        dismiss();
        router.push(`/users/${member.userId}`);
      },
    },
  ];

  // The Incharge must be in this car, so only its own members are ever offered the tag - and
  // the same tap takes it away, because a car has one Incharge or none.
  if (isManager) {
    items.push(
      member.isIncharge
        ? {
            label: 'Remove Incharge',
            onPress: () => void act(() => raceApi.setIncharge(group.id, null)),
          }
        : {
            label: 'Make Incharge',
            onPress: () => void act(() => raceApi.setIncharge(group.id, member.userId)),
          },
    );
  }

  // Leaving your own car is your own business and needs no standing (rule 19). Taking somebody
  // else out is a manager's.
  if (isSelf || isManager) {
    items.push({
      label: isSelf ? 'Leave this car' : `Remove from Group ${group.number}`,
      destructive: true,
      onPress: () => void act(() => raceApi.leaveCarGroup(raceId, member.userId)),
    });
  }

  return items;
}

function GroupCard({
  group,
  unassigned,
  isManager,
  busy,
  adding,
  onToggleAdd,
  onAssign,
  onOpenMember,
  onDelete,
}: {
  group: CarGroup;
  unassigned: readonly CarGroupPerson[];
  isManager: boolean;
  busy: boolean;
  adding: boolean;
  onToggleAdd: () => void;
  onAssign: (person: CarGroupPerson) => void;
  onOpenMember: (member: Member) => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <View style={styles.header}>
        <Text style={styles.groupTitle}>Group {group.number}</Text>
        {group.inchargeUserId === null && <Badge label="No Incharge" tone="muted" />}
        {isManager && (
          <Pressable
            onPress={onDelete}
            disabled={busy}
            hitSlop={space.sm}
            accessibilityRole="button"
            accessibilityLabel={`Delete group ${group.number}`}
          >
            <MaterialIcons name="delete-outline" size={20} color={color.textSecondary} />
          </Pressable>
        )}
      </View>

      {group.members.length === 0 ? (
        <Text style={styles.meta}>Empty.</Text>
      ) : (
        group.members.map((member) => (
          <Pressable
            key={member.userId}
            style={styles.memberRow}
            disabled={busy}
            onPress={() => onOpenMember(member)}
            accessibilityRole="button"
            accessibilityLabel={`${member.name}, options`}
          >
            <Avatar name={member.name} image={member.image} size={32} />
            <Text style={styles.member}>{member.name}</Text>
            {member.isIncharge && <Badge label="Incharge" tone="accent" />}
            <MaterialIcons
              name="more-vert"
              size={20}
              color={color.textSecondary}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          </Pressable>
        ))
      )}

      {isManager &&
        (adding ? (
          <AddToCar
            groupNumber={group.number}
            unassigned={unassigned}
            busy={busy}
            onAssign={onAssign}
            onClose={onToggleAdd}
          />
        ) : (
          <Action
            label="Add somebody"
            variant="secondary"
            disabled={busy}
            onPress={onToggleAdd}
            accessibilityLabel={`Add somebody to group ${group.number}`}
          />
        ))}
    </Card>
  );
}

/**
 * The add-member search, scoped to this race and to people with no car.
 *
 * **Filtering what is already in hand, not asking the server per keystroke.** `unassigned` is
 * already exactly the pool rule 16 describes - on this race's roster, in no group - so there is
 * nothing a round trip could add, and this keeps working on a bad connection at a race.
 *
 * **Nothing shows until something is typed.** A search that opens with every eligible name in it
 * is a list with a text box on top; the point of asking for a name is that the person doing the
 * asking already knows whose seat they are filling.
 */
function AddToCar({
  groupNumber,
  unassigned,
  busy,
  onAssign,
  onClose,
}: {
  groupNumber: number;
  unassigned: readonly CarGroupPerson[];
  busy: boolean;
  onAssign: (person: CarGroupPerson) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const results = useMemo(
    () =>
      needle.length === 0
        ? []
        : unassigned.filter((person) => person.name.toLowerCase().includes(needle)),
    [unassigned, needle],
  );

  return (
    <View style={styles.addPanel}>
      {unassigned.length === 0 ? (
        <Text style={styles.meta}>Everybody on the roster is already in a car.</Text>
      ) : (
        <>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={`Search the roster for group ${groupNumber}`}
          />

          {needle.length === 0 && (
            <Text style={styles.meta}>Type a name to find somebody with no car yet.</Text>
          )}

          {needle.length > 0 && results.length === 0 && (
            // Says what the pool actually is, rather than implying no such person exists.
            <Text style={styles.meta}>
              Nobody by that name has a seat to fill. Only people on this race's roster who are
              not already in a car can be added.
            </Text>
          )}

          {results.map((person) => (
            <Pressable
              key={person.userId}
              style={styles.result}
              disabled={busy}
              onPress={() => onAssign(person)}
              accessibilityRole="button"
              accessibilityLabel={`Add ${person.name} to group ${groupNumber}`}
            >
              <Avatar name={person.name} image={person.image} size={32} />
              <Text style={styles.member}>{person.name}</Text>
              <MaterialIcons name="add" size={20} color={color.accent} />
            </Pressable>
          ))}
        </>
      )}

      <Action label="Done" variant="quiet" onPress={onClose} />
    </View>
  );
}

/** One name in the folded-away "Remaining" list. Read-only: a seat is given from a car, not here. */
function PersonRow({ person }: { person: CarGroupPerson }) {
  return (
    <View style={styles.memberRow}>
      <Avatar name={person.name} image={person.image} size={32} />
      <Text style={styles.member}>{person.name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  groupTitle: { ...type.headline, color: color.textPrimary, flex: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 2 },
  member: { ...type.body, color: color.textPrimary, flex: 1 },
  meta: { ...type.bodySmall, color: color.textSecondary },
  addPanel: { gap: space.sm },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.appBackground,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.sm,
  },
});
