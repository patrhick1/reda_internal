import React from 'react';
import { Image, Text, View } from 'react-native';
import { colors, fonts, radii } from '@/lib/theme';

// The mark asset is a mono-white "R-cube" on transparent background, so it can
// sit inside either a black square (default) or a white square (inverted) and
// pick up the surrounding colour scheme naturally. require() rather than ES
// import is the Expo/RN convention for static assets — Metro's bundler resolves
// the path at build time and TypeScript doesn't need a .d.ts shim.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MARK = require('../../../assets/reda-mark.png');

export function RedaMark({ size = 32, inverted = false }: { size?: number; inverted?: boolean }) {
  const bg = inverted ? colors.white : colors.black;
  // Inside the box we want the mark to read in the opposite colour. The asset
  // is white-on-transparent; tint to black when inverted, leave white otherwise.
  const tint = inverted ? colors.black : colors.white;
  const padding = Math.max(2, Math.round(size * 0.12));
  return (
    <View style={{
      width: size,
      height: size,
      backgroundColor: bg,
      borderRadius: Math.min(radii.md, Math.round(size * 0.22)),
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Image
        source={MARK}
        style={{
          width: size - padding * 2,
          height: size - padding * 2,
          tintColor: tint,
        }}
        resizeMode="contain"
      />
    </View>
  );
}

export function RedaWordmark({ size = 22, inverted = false }: { size?: number; inverted?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <RedaMark size={size + 6} inverted={inverted} />
      <Text style={{
        fontFamily: fonts.extrabold,
        fontSize: size,
        letterSpacing: -0.4,
        color: inverted ? colors.white : colors.black,
      }}>
        Reda
      </Text>
    </View>
  );
}
