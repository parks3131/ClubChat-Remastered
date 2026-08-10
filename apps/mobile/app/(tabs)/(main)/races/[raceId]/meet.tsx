/**
 * Meet Information: **five fields, edited together as one form.**
 *
 * The product treats them as atomic, which has a consequence the UI has to honour: saving submits
 * all five, and a field left blank is **cleared** rather than left alone. Per-field saves are what
 * the single-form design exists to avoid - it shipped in v1 as two separate sections and was merged
 * on founder follow-up.
 *
 * Any manager can edit all five. Not restricted to whoever created the race.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { raceApi } from '../../../../../src/api.ts';
import { color, space, type } from '../../../../../src/theme.ts';
import { Action, Body, DataScreen, Field, SectionHeader } from '../../../../../src/ui.tsx';
import { MeetInformationCard } from '../../../../../src/screens/meet-information.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function MeetInformationScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const load = useLoad(() => raceApi.detail(raceId), [raceId]);
  /*
   * Which space this screen is in, for the header and for the Clubs tab's shortcut.
   *
   * The id comes from the ROUTE, so the header knows which space it is drawing before the name
   * arrives - that is what stops it showing the previous screen's name for a frame. Everything
   * else comes from the read, because a race and an Eboard space each know their own club and the
   * route does not carry it.
   */
  useDeclareRace(
    raceId,
    load.data?.race.clubId,
    load.data?.race.name,
    load.data?.race.image,
  );

  return (
    <DataScreen load={load}>
      {(data) =>
        data.race.viewer.isManager ? (
          <MeetForm raceId={raceId} initial={data.race} />
        ) : (
          /*
            A member READS it here. Only editing is admin-gated.

            > **This branch used to render a sentence saying a club admin edits it and that the
            > information could be read on the race screen** - which sent somebody who had just
            > asked to see it somewhere else to see it, and threw away content the server had
            > already sent. `GET /races/:id` returns all five fields to any club member, including
            > one with no roster row at all.

            [`PRD/09`](../../../SPEC/PRD/09-races-and-meets.md) rule 13 makes Meet Information
            readable by any club member precisely because it is what somebody uses to decide
            whether to go, and rule 5 of `PRD/05` on the header quick-nav says the same thing from
            the other side: reaching a screen is not acting on it, and every destination applies
            its own rules on arrival. The rule those two produce together is content shown,
            controls absent - never the content withheld.
          */
          <Body>
            <MeetInformationCard race={data.race} />
          </Body>
        )
      }
    </DataScreen>
  );
}

function MeetForm({
  raceId,
  initial,
}: {
  raceId: string;
  initial: {
    meetDescription: string | null;
    meetLocationUrl: string | null;
    meetHotelUrl: string | null;
    meetPhotosUrl: string | null;
    meetResultsUrl: string | null;
  };
}) {
  const router = useRouter();
  const [description, setDescription] = useState(initial.meetDescription ?? '');
  const [location, setLocation] = useState(initial.meetLocationUrl ?? '');
  const [hotel, setHotel] = useState(initial.meetHotelUrl ?? '');
  const [photos, setPhotos] = useState(initial.meetPhotosUrl ?? '');
  const [results, setResults] = useState(initial.meetResultsUrl ?? '');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    const orNull = (value: string) => (value.trim().length > 0 ? value.trim() : null);
    try {
      // All five, every time. This is the whole-form contract, not a convenience.
      await raceApi.saveMeetInformation(raceId, {
        meetDescription: orNull(description),
        meetLocationUrl: orNull(location),
        meetHotelUrl: orNull(hotel),
        meetPhotosUrl: orNull(photos),
        meetResultsUrl: orNull(results),
      });
      router.back();
    } catch {
      setFailed('Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="Meet Information" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />
      <Field label="Location link" value={location} onChangeText={setLocation} keyboardType="url" />
      <Field label="Hotel link" value={hotel} onChangeText={setHotel} keyboardType="url" />
      <Field label="Photos link" value={photos} onChangeText={setPhotos} keyboardType="url" />
      <Field label="Results link" value={results} onChangeText={setResults} keyboardType="url" />

      <Text style={styles.meta}>
        All five save together. Anything you leave blank is cleared. Details, location and hotel are
        hidden from the race screen when empty; photos and results show "Stay tuned" instead.
      </Text>

      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action
          label="Cancel"
          variant="secondary"
          style={styles.actionButton}
          onPress={() => router.back()}
        />
        <Action
          label={busy ? 'Saving' : 'Save all five'}
          style={styles.actionButton}
          disabled={busy}
          onPress={() => void save()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
