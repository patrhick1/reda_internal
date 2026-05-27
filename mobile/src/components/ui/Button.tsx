import React, { useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { Text, Pressable, Animated } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'emphasis' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = {
  children?: React.ReactNode;
  title?: string; // legacy alias for children, kept for migration ergonomics
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  full?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
  /** Override the screen-reader label. Defaults to children/title when those
   *  are strings. Required when the button is icon-only. */
  accessibilityLabel?: string;
};

const VARIANT_STYLES: Record<
  ButtonVariant,
  { bg: string; fg: string; borderColor?: string; borderWidth?: number }
> = {
  primary: { bg: colors.black, fg: colors.white },
  emphasis: { bg: colors.red, fg: colors.white },
  secondary: { bg: colors.white, fg: colors.black, borderColor: colors.black, borderWidth: 1.5 },
  ghost: { bg: 'transparent', fg: colors.black },
  destructive: { bg: colors.white, fg: colors.red, borderColor: colors.red, borderWidth: 1.5 },
};

export function Button({
  children,
  title,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  full,
  disabled,
  onPress,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const v = VARIANT_STYLES[variant];
  const sm = size === 'sm';
  const scale = useRef(new Animated.Value(1)).current;
  const label = children ?? title;
  const iconSize = sm ? 16 : 18;
  const a11yLabel = accessibilityLabel ?? (typeof label === 'string' ? label : undefined);

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled: !!disabled }}
      onPressIn={() =>
        Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 50 }).start()
      }
      onPressOut={() =>
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50 }).start()
      }
      style={({ pressed }) => [
        {
          opacity: disabled ? 0.5 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
          width: full ? '100%' : undefined,
        },
        pressed && !disabled ? { opacity: 0.92 } : null,
      ]}
    >
      <Animated.View
        style={{
          transform: [{ scale }],
          backgroundColor: v.bg,
          borderRadius: 999,
          minHeight: sm ? 36 : 48,
          paddingHorizontal: sm ? 16 : 22,
          borderWidth: v.borderWidth ?? 0,
          borderColor: v.borderColor ?? 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          ...(style as object),
        }}
      >
        {icon ? <Icon name={icon} size={iconSize} color={v.fg} /> : null}
        {typeof label === 'string' ? (
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: sm ? 13 : 15,
              color: v.fg,
              letterSpacing: -0.1,
            }}
          >
            {label}
          </Text>
        ) : (
          (label as React.ReactNode)
        )}
        {iconRight ? <Icon name={iconRight} size={iconSize} color={v.fg} /> : null}
      </Animated.View>
    </Pressable>
  );
}
