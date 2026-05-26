import React from 'react';
import type { ViewStyle } from 'react-native';
import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type BannerTone = 'info' | 'warn' | 'error' | 'ok';

const PALETTE: Record<BannerTone, { bg: string; border: string; text: string }> = {
  info:  { bg: colors.infoSoft,    border: colors.infoBorder, text: colors.infoDark },
  warn:  { bg: colors.warningSoft, border: '#FCD34D',         text: colors.warningDark },
  error: { bg: colors.redSoft,     border: '#FCA5A5',         text: colors.red },
  ok:    { bg: colors.successSoft, border: '#86EFAC',         text: colors.successDark },
};

export type BannerProps = {
  tone?: BannerTone;
  icon?: IconName;
  title?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewStyle;
};

export function Banner({ tone = 'info', icon = 'alert', title, children, right, style }: BannerProps) {
  const p = PALETTE[tone];
  return (
    <View style={{
      backgroundColor: p.bg,
      borderColor: p.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      flexDirection: 'row',
      gap: 10,
      alignItems: 'flex-start',
      ...(style as object),
    }}>
      <Icon name={icon} size={18} color={p.text} />
      <View style={{ flex: 1 }}>
        {title ? (
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: p.text, marginBottom: 2 }}>
            {title}
          </Text>
        ) : null}
        {typeof children === 'string' ? (
          <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: p.text, lineHeight: 19 }}>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
      {right}
    </View>
  );
}
