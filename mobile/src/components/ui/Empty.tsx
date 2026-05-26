import React from 'react';
import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export function Empty({ icon = 'package', title, sub }: { icon?: IconName; title: string; sub?: string }) {
  return (
    <View style={{
      alignItems: 'center',
      padding: 40,
      gap: 12,
    }}>
      <View style={{
        width: 64, height: 64, borderRadius: 32,
        backgroundColor: colors.surface,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon name={icon} size={28} color={colors.textSecondary} stroke={1.5} />
      </View>
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>{title}</Text>
        {sub ? (
          <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 240, marginTop: 4, lineHeight: 18 }}>
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
