import React from 'react';
import type { ViewStyle } from 'react-native';
import { View, Pressable } from 'react-native';
import { colors, radii } from '@/lib/theme';

export type CardProps = {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  dense?: boolean;
  style?: ViewStyle;
};

export function Card({ children, onPress, onLongPress, dense, style }: CardProps) {
  const padding = dense ? 12 : 16;
  const content = (
    <View
      style={{
        backgroundColor: colors.white,
        borderRadius: radii.card,
        padding,
        shadowColor: colors.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 3,
        elevation: 1,
        ...(style as object),
      }}
    >
      {children}
    </View>
  );
  if (!onPress && !onLongPress) return content;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => (pressed ? { opacity: 0.92 } : null)}
    >
      {content}
    </Pressable>
  );
}
