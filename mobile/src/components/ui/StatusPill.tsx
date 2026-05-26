import React from 'react';
import { Text, View } from 'react-native';
import { colors, fonts, STATUS_META, TONE_PALETTE } from '@/lib/theme';

export type StatusPillProps = {
  status: string;
  variant?: 'filled' | 'subtle';
  size?: 'sm' | 'md';
};

export function StatusPill({ status, variant = 'filled', size = 'md' }: StatusPillProps) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'gray' as const, desc: '' };
  const tone = TONE_PALETTE[meta.tone];
  const subtle = variant === 'subtle';
  const sm = size === 'sm';

  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: subtle ? tone.soft : tone.bg,
      paddingHorizontal: sm ? 8 : 10,
      paddingVertical: sm ? 2 : 4,
      borderRadius: 999,
      alignSelf: 'flex-start',
    }}>
      <View style={{
        width: sm ? 5 : 6,
        height: sm ? 5 : 6,
        borderRadius: 999,
        backgroundColor: subtle ? tone.bg : colors.white,
      }} />
      <Text style={{
        color: subtle ? tone.softText : colors.white,
        fontFamily: fonts.semibold,
        fontSize: sm ? 10 : 11,
        lineHeight: sm ? 14 : 16,
      }}>
        {meta.label}
      </Text>
    </View>
  );
}
