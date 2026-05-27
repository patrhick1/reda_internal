import React from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '@/lib/theme';
import { Icon } from './Icon';
import { RedaMark } from './RedaMark';
import type { HelpTopic } from '@/help/content';

export type AppBarProps = {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  /** Renders a `?` button on the right that deep-links into the help screen
   *  for this topic. Ignored if `right` is also set. */
  helpTopic?: HelpTopic;
  dark?: boolean;
  onBack?: () => void;
};

export function AppBar({
  title,
  subtitle,
  left,
  right,
  helpTopic,
  dark = false,
  onBack,
}: AppBarProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const bg = dark ? colors.black : colors.white;
  const fg = dark ? colors.white : colors.black;
  const subFg = dark ? colors.textTertiary : colors.textSecondary;

  const leading =
    left ??
    (onBack ? (
      <TouchableOpacity onPress={onBack} hitSlop={8} style={{ padding: 4, marginLeft: -4 }}>
        <Icon name="chevronLeft" size={26} color={fg} />
      </TouchableOpacity>
    ) : (
      <RedaMark size={28} inverted={dark} />
    ));

  const trailing =
    right ??
    (helpTopic ? (
      <TouchableOpacity
        onPress={() => router.push({ pathname: '/(profile)/help', params: { topic: helpTopic } })}
        hitSlop={8}
        style={{ padding: 4 }}
        accessibilityLabel="Help"
        accessibilityRole="button"
      >
        <Icon name="helpCircle" size={22} color={fg} />
      </TouchableOpacity>
    ) : null);

  return (
    <View
      style={{
        backgroundColor: bg,
        borderBottomWidth: 1,
        borderBottomColor: dark ? '#222' : colors.border,
        paddingHorizontal: 16,
        paddingTop: insets.top + 12,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56 + insets.top,
      }}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fonts.bold, fontSize: 16, color: fg, letterSpacing: -0.2 }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ fontFamily: fonts.medium, fontSize: 12, color: subFg, marginTop: 1 }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
