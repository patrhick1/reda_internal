import React from 'react';
import { Text, Pressable, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type FABProps = {
  icon: IconName;
  label?: string;
  onPress: () => void;
  color?: string;
  bottom?: number;
  /** Screen-reader label. Falls back to `label` when present. Required for
   *  icon-only FABs. */
  accessibilityLabel?: string;
};

export function FAB({ icon, label, onPress, color = colors.red, bottom = 80, accessibilityLabel }: FABProps) {
  return (
    <View pointerEvents="box-none" style={{
      position: 'absolute', right: 16, bottom, zIndex: 10,
    }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label ?? icon}
        style={({ pressed }) => ([{
          backgroundColor: color,
          height: 52,
          paddingHorizontal: label ? 20 : 0,
          paddingLeft: label ? 18 : 0,
          width: label ? undefined : 52,
          minWidth: 52,
          borderRadius: 26,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          justifyContent: 'center',
          shadowColor: color,
          shadowOpacity: 0.35,
          shadowOffset: { width: 0, height: 10 },
          shadowRadius: 24,
          elevation: 8,
        }, pressed && { opacity: 0.92 }])}
      >
        <Icon name={icon} size={22} color={colors.white} />
        {label ? (
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>{label}</Text>
        ) : null}
      </Pressable>
    </View>
  );
}
