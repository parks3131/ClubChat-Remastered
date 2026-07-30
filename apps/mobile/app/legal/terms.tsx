/**
 * Terms.
 *
 * Reachable signed out as well as signed in, for the same reason as the Privacy Policy: sign-up
 * links to both from its consent line.
 */

import { StyleSheet, Text } from 'react-native';
import { Body, SectionHeader } from '../../src/ui.tsx';
import { color, type } from '../../src/theme.ts';

export default function TermsScreen() {
  return (
    <Body>
      <SectionHeader title="Using ClubChat" />
      <Text style={styles.p}>
        ClubChat is for running clubs and their members to organise chat, races, calendars and
        training. You are responsible for what you post.
      </Text>

      <SectionHeader title="Behaviour" />
      <Text style={styles.p}>
        Do not harass, threaten or impersonate anybody. Do not post content you have no right to
        post. Club admins moderate their own clubs; reports in a direct message go to a platform
        moderator, because a conversation between two people has no admin.
      </Text>

      <SectionHeader title="Your club, your content" />
      <Text style={styles.p}>
        You keep ownership of what you post. Deleting a club removes its chat history, races,
        meetings and polls for every member of it.
      </Text>

      <SectionHeader title="Ending it" />
      <Text style={styles.p}>
        You can delete your account at any time from your profile. If you own a club you will be
        asked to hand it over or delete it first, because a club without an Owner cannot be
        recovered.
      </Text>

      <Text style={styles.draft}>This is an in-house first draft and is not legal advice.</Text>
    </Body>
  );
}

const styles = StyleSheet.create({
  p: { ...type.body, color: color.textPrimary },
  draft: { ...type.bodySmall, color: color.textSecondary, fontStyle: 'italic' },
});
