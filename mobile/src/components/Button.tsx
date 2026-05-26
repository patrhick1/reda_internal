import type { ViewStyle } from 'react-native';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { colors, fonts } from '@/lib/theme';

/**
 * Legacy Button retained for older catalog/form screens.
 * Restyled to use the Reda design tokens. New screens should import from
 * `@/components/ui` instead.
 */
type Variant = 'primary' | 'secondary' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  const palette = {
    primary:   { bg: colors.black, fg: colors.white, border: 'transparent', borderWidth: 0 },
    secondary: { bg: colors.white, fg: colors.black, border: colors.black,  borderWidth: 1.5 },
    danger:    { bg: colors.red,   fg: colors.white, border: 'transparent', borderWidth: 0 },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      style={({ pressed }) => ([{
        minHeight: 48,
        paddingHorizontal: 22,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.bg,
        borderColor: palette.border,
        borderWidth: palette.borderWidth,
        opacity: isDisabled ? 0.5 : 1,
      }, pressed && !isDisabled ? { opacity: 0.92 } : null, style as object])}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <Text style={{
          fontFamily: fonts.bold,
          fontSize: 15,
          color: palette.fg,
          letterSpacing: -0.1,
        }}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}
