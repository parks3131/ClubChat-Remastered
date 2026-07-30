/**
 * Races & Meets for a club.
 *
 * **Every club member sees every race**, whether or not they can enter it - a member needs to know
 * a race exists in order to ask to join it, so a race with no access is a row that says so rather
 * than a row that is missing. `PRD/09` rule 2.
 *
 * Pinning is personal: it moves the race up this viewer's own list and nobody else's.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareClub } from '../../../../../../src/current-club.tsx';
import { clubApi, raceApi } from '../../../../../../src/api.ts';
import { color, space, type } from '../../../../../../src/theme.ts';
import {
  Action,
  Badge,
  Body,
  DataScreen,
  EmptyState,
  Field,
  Row,
  SectionHeader,
} from '../../../../../../src/ui.tsx';
import { useLoad } from '../../../../../../src/use-load.ts';

export default function ClubRacesScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useLoad(() => raceApi.list(clubId, term.trim() || undefined), [clubId, term]);
  // Loaded for one flag: whether this viewer may create a race. Read from the club rather than
  // from a race row, because a club with no races has no row to read it from.
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);

  if (creating) {
    return (
      <CreateRace
        clubId={clubId}
        onCancel={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          load.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.searchWrap}>
        <Field label="Search races" value={term} onChangeText={setTerm} placeholder="Regionals" />
      </View>

      <DataScreen
        load={load}
        isEmpty={(data) => data.races.length === 0}
        empty={
          <EmptyState
            title={term.trim().length > 0 ? 'No races found' : 'No upcoming races yet'}
            body={term.trim().length > 0 ? undefined : 'An admin creates a race with a name and a date.'}
          />
        }
      >
        {(data) => (
          <Body>
            {data.races.map((race) => (
              <Row
                key={race.id}
                title={race.name}
                subtitle={`${race.raceDate}  ·  ${race.memberCount} going`}
                href={`/races/${race.id}`}
                right={
                  <>
                    {race.pinned && <Badge label="Pinned" tone="accent" />}
                    {race.requestPending && <Badge label="Requested" tone="muted" />}
                    {/* Says which it is rather than hiding the race. */}
                    {!race.hasAccess && !race.requestPending && (
                      <Badge label="No access" tone="muted" />
                    )}
                  </>
                }
              />
            ))}
            {/* Any member can pin any race they can see - not admin-gated. */}
            <Text style={styles.meta}>
              Open a race to pin it to your own hub, or to ask to join.
            </Text>
          </Body>
        )}
      </DataScreen>

      {/* Only an admin may create one, and the server refuses everybody else regardless. */}
      {club.data?.club.viewer.isAdmin === true && (
        <View style={styles.footer}>
          <Action label="Create a race" onPress={() => setCreating(true)} />
        </View>
      )}
    </View>
  );
}

function CreateRace({
  clubId,
  onCancel,
  onCreated,
}: {
  clubId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A name and a date only. No start time, no capacity - those are open questions, not omissions.
  const valid = name.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date.trim());

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const created = await raceApi.create(clubId, { name: name.trim(), raceDate: date.trim() });
      onCreated();
      router.push(`/races/${created.raceId}`);
    } catch {
      setFailed('Could not create the race. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="New race" />
      <Field label="Name" value={name} onChangeText={setName} placeholder="Regionals" />
      <Field label="Date" value={date} onChangeText={setDate} placeholder="2027-09-12" />
      <Text style={styles.meta}>
        A race has a day, not a time. Everyone in the club will see it; access is by request.
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Creating' : 'Create'}
          style={styles.actionButton}
          disabled={!valid || busy}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  searchWrap: { padding: space.md, paddingBottom: 0 },
  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
