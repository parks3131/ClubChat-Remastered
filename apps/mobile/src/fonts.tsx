/**
 * The font gate.
 *
 * > **`SPEC/TECH/13` rule 4: the whole app is gated on fonts being loaded, so no screen ever
 * > flashes system fonts.** That is a stated structural rule and it had no implementation - the
 * > app rendered in the platform default at the right sizes, which looks deliberate enough to
 * > survive a casual look and is not the design.
 *
 * Three families, each doing one job (rule 3 - a role is a complete family/size/line-height
 * triple, and the family half was the part missing):
 *
 * | Family | Used for |
 * |---|---|
 * | Anton | display, and **every header title** |
 * | Archivo Narrow | body, and numeric emphasis |
 * | Inter SemiBold | labels, badges and buttons - uppercase and letterspaced |
 *
 * Anton ships in one weight only, which is why it is the display face rather than a body one.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Anton_400Regular } from '@expo-google-fonts/anton';
import {
  ArchivoNarrow_400Regular,
  ArchivoNarrow_700Bold,
} from '@expo-google-fonts/archivo-narrow';
import { Inter_400Regular, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { color } from './theme.ts';

/*
 * The family NAMES live in `theme.ts`, not here: a family name is a token, and this module needs
 * `color` for its spinner - so defining them here made the two modules import each other, which
 * failed at runtime with "Cannot access 'color' before initialization". The token module imports
 * nothing; everything imports it.
 */

/**
 * Hold the app until the faces are ready.
 *
 * A spinner rather than `null`, because a blank screen during a slow font fetch is
 * indistinguishable from the app being broken - which is the failure `PRD/03` warns about and
 * which reads as a crash to whoever is holding the phone.
 *
 * If loading **fails**, the app renders anyway. A missing font is a visual regression; a permanent
 * spinner is a dead app, and the second is much worse than the first.
 */
export function FontGate({ children }: { children: ReactNode }) {
  const [loaded, error] = useFonts({
    Anton_400Regular,
    ArchivoNarrow_400Regular,
    ArchivoNarrow_700Bold,
    Inter_400Regular,
    Inter_600SemiBold,
  });

  if (!loaded && error === null) {
    return (
      <View style={styles.gate}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.appBackground,
  },
});
