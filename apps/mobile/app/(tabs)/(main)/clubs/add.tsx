/**
 * Join or create a club - the chat list's "+" action.
 *
 * A chooser rather than a form. The two ways into a club are already screens of their own with
 * their own validation and their own headers, and this exists because the chat list has one slot
 * for "get me into a club" where the old My Clubs screen had room for two full-width buttons.
 *
 * **There is deliberately no third option here.** ADR-0010 removed the typed invite code: a link
 * is the only invite mechanism, and a code-entry screen is an absence the product maintains
 * rather than a feature nobody got round to. Joining by link happens by opening the link.
 */

import { StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { Body } from '../../../../src/ui.tsx';
import { Pressable } from 'react-native';

export default function AddClubScreen() {
  const router = useRouter();

  return (
    <Body>
      <Text style={styles.lede}>
        Join a club you have been told about, or start one of your own.
      </Text>

      <View style={styles.options}>
        <Choice
          icon="explore"
          title="Join a club"
          body="Search for a club by name. Open clubs let you in straight away; others send a request to an admin."
          onPress={() => router.push('/clubs/join')}
        />
        <Choice
          icon="add-circle"
          title="Create a club"
          body="Name it, say who can join, and you are its owner. Its chat and its Eboard space are made with it."
          onPress={() => router.push('/clubs/create')}
        />
      </View>

      {/*
        Said plainly rather than left to be discovered, because the alternative is somebody
        hunting this screen for a code box that does not exist and concluding the app is broken.
      */}
      <Text style={styles.footnote}>
        Got an invite link? Just open it - it takes you straight in, even for a club that normally
        asks an admin to approve.
      </Text>
    </Body>
  );
}

function Choice({
  icon,
  title,
  body,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={styles.choice}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.well}>
        <MaterialIcons name={icon} size={22} color={color.onAccent} />
      </View>
      <View style={styles.choiceText}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceBody}>{body}</Text>
      </View>
      <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lede: { ...type.body, color: color.textSecondary, marginBottom: space.md },
  options: { gap: space.sm },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  // The filled circular well the club hub's rows use, so a row that leads somewhere looks the
  // same wherever it appears.
  well: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceText: { flex: 1, gap: 2 },
  choiceTitle: { ...type.headline, fontSize: 17, color: color.textPrimary },
  choiceBody: { ...type.bodySmall, color: color.textSecondary },
  footnote: {
    ...type.bodySmall,
    color: color.textSecondary,
    marginTop: space.lg,
    textAlign: 'center',
  },
});
