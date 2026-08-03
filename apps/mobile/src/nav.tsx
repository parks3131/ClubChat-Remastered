/**
 * Navigation pieces that every screen shares.
 *
 * The rule these exist to hold: **every screen must be navigable back out when reached with no
 * history** - a deep link, a page refresh, a notification tap. The navigator renders its own back
 * button only when history exists, so a screen that relies on it looks correct until somebody
 * arrives from outside. `SPEC/PRD/15` rule 3, and it has shipped as a bug twice here.
 *
 * The consequence is that a parent is **declared**, not inferred. Every screen states where "back"
 * goes when there is nowhere to return to.
 */

import { MaterialIcons } from '@expo/vector-icons';
import { Link, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { arrivedMarker } from './arrived.ts';
import { useCurrentSpace, type SpaceKind } from './current-space.tsx';
import { RemoteImage } from './media-bubble.tsx';
import { color, radius, space, type } from './theme.ts';

/**
 * How every screen enters and leaves.
 *
 * > **One motion, one meaning: right-to-left is going in, left-to-right is coming out.** That is
 * > what a stack push and pop already do on iOS, and declaring it here rather than inheriting it
 * > makes it true on Android too, where the platform default differs.
 *
 * `gestureEnabled` is the same motion under a thumb instead of under the header, so it belongs
 * with the animation rather than being a separate decision.
 *
 * `animationTypeForReplace: 'pop'` is the default because most replaces in this app are a way
 * OUT: a back control with no history to pop, an edit that saved, a club that was deleted, a
 * sign-out. The handful that are a way IN - you created a thing and landed on it - say so with
 * a route param and override this per screen. See `ARRIVED_FORWARD`.
 */
export const STACK_MOTION = {
  animation: 'slide_from_right',
  gestureEnabled: true,
  animationTypeForReplace: 'pop',
} as const;

/**
 * The query param a forward `replace` carries, and the options it implies.
 *
 * A replace has no direction of its own - it swaps the top of the stack - so the screen being
 * replaced INTO is the only place that can say which way the motion should read. Creating a club
 * and landing on it is going in, even though the form must not be left behind; without this it
 * would slide out, which reads as retreating from something you just made.
 */
export const ARRIVED_FORWARD = 'arrived=forward';

/**
 * The marker a REDIRECT carries, which is a third thing again.
 *
 * A race and an Eboard space both send a real member straight into chat, so entering one is a
 * push onto a landing screen that immediately replaces itself. Left alone that is two animations
 * for one act - slide in, then slide back out into the conversation - which is what "weird
 * animation both ways when going in" was.
 *
 * The landing is a routing decision rather than a destination: nobody meant to be there. So the
 * swap is instant, and what the member sees is the single slide they asked for, landing on chat.
 * Club chat never had this because its hub links straight to the channel with no landing at all.
 */
export const ARRIVED_REDIRECT = 'arrived=redirect';

export function motionFor(params: unknown) {
  // Through `arrivedMarker` rather than off `params` directly, because a GROUP route is handed the
  // route to the leaf rather than the leaf's params - which is why `(tabs)` could not see this.
  switch (arrivedMarker(params)) {
    case 'forward':
      return { animationTypeForReplace: 'push' } as const;
    case 'redirect':
      /*
        **Both, and `animationTypeForReplace` is the one that was missing.**

        A first attempt set only `animation: 'none'`, reasoning that an unseen landing screen
        needs no transition. It did not work, and the video showed why: for a REPLACE the
        direction option decides, so the stack's `pop` default still ran and the conversation
        slid in from the left - going into a race animated as coming back out of one.

        `push` fixes the direction; `none` suppresses the motion where it is honoured. Entering
        a race or an Eboard space is a push onto a landing screen that immediately replaces
        itself, and the landing never paints, so what is left is the single slide inward that
        entering anything else gives.
      */
      return { animationTypeForReplace: 'push', animation: 'none' } as const;
    default:
      return {} as const;
  }
}

/**
 * Going back: **pop if there is history, fall back to the declared parent if there is not.**
 *
 * A hook rather than logic inside `BackTo`, because two screens cannot use `BackTo` at all. Chat
 * and Highlights replace the native header with their own glass-blur one, so they hand-roll the
 * control - and when this rule lived only inside `BackTo`, both of them kept the old
 * always-replace behaviour and nobody noticed until somebody tapped back inside a conversation
 * and watched it refuse to unwind. This is the second time in this project that a rule written
 * once and re-implemented twice has diverged; the hook is so there is one definition of "back"
 * rather than three.
 */
export function useGoBack(href: string): () => void {
  const router = useRouter();
  return () => {
    // `canGoBack()` rather than a try/catch around `back()`: popping an empty stack throws, and a
    // thrown navigation is indistinguishable from a dead control to whoever tapped it.
    if (router.canGoBack()) router.back();
    else router.replace(href);
  };
}

/**
 * An explicit back control, rendered whether or not history exists.
 *
 * **Permanent furniture, never conditional.** A native back button renders only when there is
 * history, and a refresh, a deep link and a notification tap all produce none - so a screen
 * relying on it looks correct until somebody arrives from outside. That is the single most
 * repeated bug in this project's history.
 *
 * > **It pops first and falls back second, and the order matters.** Popping returns to the actual
 * > previous screen with its scroll position and state intact; the declared parent is the answer
 * > only when there is nothing to pop. An earlier version always navigated to the parent, which
 * > looks identical on the first tap and is wrong on every subsequent one - it discards the state
 * > of the screen being returned to and grows the stack instead of unwinding it.
 *
 * The parent is a **declared property of the screen**, not a guess: always one meaningful level
 * up, never "the tab root" and never nothing. See the back-target table in `SPEC/PRD/15`.
 */
export function BackTo({
  href,
  label,
  variant = 'label',
}: {
  href: string;
  label: string;
  /**
   * **`icon` is the nested header, everywhere.** v1 draws `arrow-back` and never a word.
   *
   * `label` renders the parent's NAME as the control and is now used by nothing in the app. It
   * survives because the failure is worth being able to point at: a word in the header's label
   * style sits beside the title reading as an eyebrow, not as a button, and the first person to
   * see one reported the back button as missing. Reach for it only if a header ever genuinely
   * needs its destination spelled out - and expect that report again if you do.
   */
  variant?: 'label' | 'icon';
}) {
  const go = useGoBack(href);

  return (
    <Pressable
      onPress={go}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      hitSlop={space.sm}
      // The screen gutter as horizontal padding. The navigator renders this slot flush to x=0
      // on web, so without it the control touches the edge of the viewport.
      style={styles.backWrap}
    >
      {variant === 'icon' ? (
        <MaterialIcons name="arrow-back" size={22} color={color.accent} />
      ) : (
        <Text style={styles.back}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * A back control that ALWAYS goes to its target, ignoring whatever history exists.
 *
 * For the two cross-stack jumps where popping is a live loop rather than a convenience: a club hub
 * opened from Profile's club chips, and one opened by the Clubs tab shortcut. In both the previous
 * entry is somewhere the person did not come "down" from, so unwinding to it sends them sideways
 * and then bounces them back. See `SPEC/PRD/15`'s special cases.
 */
export function BackAlwaysTo({
  href,
  label,
  variant = 'label',
}: {
  href: string;
  label: string;
  variant?: 'label' | 'icon';
}) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.replace(href)}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      hitSlop={space.sm}
      style={styles.backWrap}
    >
      {variant === 'icon' ? (
        <MaterialIcons name="arrow-back" size={22} color={color.accent} />
      ) : (
        <Text style={styles.back}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * Back to the club you are inside, whichever it is.
 *
 * A race and an Eboard space each belong to one club, but their routes carry only their own id -
 * so a parent built from route params cannot name the club hub. The club comes from the context
 * those screens already declare, and `/clubs` is the honest fallback for the instant before their
 * read lands.
 *
 * This is why there is no races LIST screen to go back to: v1 has none, and a list that exists
 * only to be a back target is a screen the product does not want.
 */
export function BackToClub() {
  const { currentClub } = useCurrentSpace();
  const href = currentClub === null ? '/clubs' : `/clubs/${currentClub.clubId}`;
  const go = useGoBack(href);

  return (
    <Pressable
      onPress={go}
      accessibilityRole="button"
      accessibilityLabel="Back to the club"
      hitSlop={space.sm}
      style={styles.backWrap}
    >
      <MaterialIcons name="arrow-back" size={22} color={color.accent} />
    </Pressable>
  );
}

/** Where a space's own profile lives. One definition, because four screens link to it. */
export function spaceProfileHref(kind: SpaceKind, id: string): string {
  if (kind === 'race') return `/races/${id}/profile`;
  if (kind === 'eboard') return `/eboard/${id}/profile`;
  return `/clubs/${id}/profile`;
}

/**
 * A space's own identity as a header title: its avatar, then its name, in the accent.
 *
 * v1 gives every screen inside a club, a race or Eboard & Council this header rather than the
 * screen's own name, and the whole thing is tappable through to that space's profile. It does
 * two jobs at once - it says where you are from four levels deep, and it makes the place's
 * identity reachable from everywhere without a menu.
 *
 * > **`expect` is what stops the header flashing the wrong name**, and it is the reason this
 * > takes a prop at all rather than trusting the context alone. Walking from a club hub into a
 * > race pushes the race's screen while the context still says "club" - its own declaration is a
 * > focus effect, which runs after the first paint. Rendering whatever the context happens to
 * > hold therefore drew the CLUB's name and face for a frame and then swapped them, which is
 * > exactly the flicker this was reported for one level up. So the route says which space it is
 * > drawing, and a declaration for anything else is not ours to draw.
 *
 * The context still supplies the name and the picture, because the layout configures the header
 * and only the screen has the data. The route knows the identity; the context knows the details.
 */
export function SpaceHeaderTitle({
  expect,
  fallback,
}: {
  /** The space this route is for, straight from its params. */
  expect: { kind: SpaceKind; id: string | undefined };
  /** Drawn only when nothing at all has been declared, where an empty bar would read as broken. */
  fallback: string;
}) {
  const { currentSpace } = useCurrentSpace();
  const router = useRouter();

  if (currentSpace === null) return <Text style={styles.clubName}>{fallback}</Text>;

  /*
   * Three unknowns, drawn two ways.
   *
   *  - **A declaration for a different space** - the screen below this one, still in the context
   *    for a frame: render nothing. It is about to be replaced by ours.
   *  - **Ours, name not yet arrived** (a cold deep link, a refresh): render nothing. The name is
   *    milliseconds away, and a word that visibly swaps for another word is the flicker. Empty
   *    for an instant is quiet; "Club" turning into "Binghamton Running Club" is not.
   *  - **Nothing declared at all**: the screen's own title, handled above, because nothing is
   *    coming and an empty header really would read as broken.
   */
  if (currentSpace.kind !== expect.kind || currentSpace.id !== expect.id) return null;
  if (currentSpace.name.length === 0) return null;

  return (
    <Pressable
      onPress={() => router.push(spaceProfileHref(currentSpace.kind, currentSpace.id))}
      accessibilityRole="button"
      accessibilityLabel={`${currentSpace.name}, open its profile`}
      style={styles.clubTitle}
    >
      {currentSpace.image === null ? (
        <View style={styles.clubAvatar}>
          <Text style={styles.clubInitial}>{currentSpace.name.charAt(0).toUpperCase()}</Text>
        </View>
      ) : (
        <RemoteImage
          mediaId={currentSpace.image}
          variant="thumb"
          style={styles.clubAvatar}
          resizeMode="cover"
        />
      )}
      <Text style={styles.clubName} numberOfLines={1}>
        {currentSpace.name}
      </Text>
    </Pressable>
  );
}

/**
 * A header action on the right.
 *
 * Always carries a label, because a header control is the most likely thing in the app to be
 * icon-only and therefore invisible to a screen reader - which is exactly what happened in v1.
 */
export function HeaderAction({
  href,
  onPress,
  label,
}: {
  href?: string;
  onPress?: () => void;
  label: string;
}) {
  const text = <Text style={styles.action}>{label}</Text>;
  if (href !== undefined) {
    return (
      <Link href={href} asChild accessibilityRole="button" accessibilityLabel={label}>
        <Pressable style={styles.actionWrap}>{text}</Pressable>
      </Link>
    );
  }
  return (
    <Pressable
      style={styles.actionWrap}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {text}
    </Pressable>
  );
}

/**
 * The header quick-nav strip under a chat or hub header.
 *
 * `PRD/15` gives club chat "Members · Poll · Routines · Events" and race chat "Members · Meet
 * Information · Polls · Car Assignments and Groups". One component, given different entries,
 * rather than one per scope - design-system rule 5.
 */
export function QuickNav({ items }: { items: ReadonlyArray<{ href: string; label: string }> }) {
  return (
    <View style={styles.quickNav}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          asChild
          accessibilityRole="button"
          accessibilityLabel={item.label}
        >
          <Pressable style={styles.quickItem}>
            <Text style={styles.quickLabel}>{item.label}</Text>
          </Pressable>
        </Link>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  backWrap: { paddingHorizontal: space.md, paddingVertical: space.xs },
  clubTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // 40px, which is v1's. The club's identity is the whole title here, so it carries the weight
  // an app masthead would elsewhere rather than sitting as a small ornament beside the name.
  clubAvatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clubInitial: { ...type.label, fontSize: 16, color: color.accent },
  clubName: { ...type.headerTitle, fontSize: 19, lineHeight: 24, color: color.accent },
  back: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  actionWrap: { paddingHorizontal: space.md, paddingVertical: space.xs },
  action: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  quickNav: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  quickItem: {
    backgroundColor: color.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quickLabel: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
});
