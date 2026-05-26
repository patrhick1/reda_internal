import React from 'react';
import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';

export function SectionHeader({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <View style={{
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}>
      <Text style={{
        fontFamily: fonts.bold,
        fontSize: 12,
        color: colors.textSecondary,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
      }}>
        {children}
      </Text>
      {right}
    </View>
  );
}
