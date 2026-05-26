import React from 'react';
import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';

export type AvatarUser = {
  display_name?: string | null;
  name?: string | null;
  initials?: string | null;
  color?: string | null;
};

function initialsFrom(user: AvatarUser): string {
  if (user.initials) return user.initials;
  const name = user.display_name ?? user.name ?? '';
  return name.split(/\s+/).filter(Boolean).map(s => s[0]!.toUpperCase()).slice(0, 2).join('') || '?';
}

// Deterministic color per name so the same agent always gets the same swatch.
const PALETTE = ['#0A0A0A', '#E63027', '#16A34A', '#2563EB', '#F59E0B', '#7C3AED', '#0EA5E9', '#DB2777'];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export function Avatar({ user, size = 40 }: { user: AvatarUser; size?: number }) {
  const bg = user.color ?? colorFor(user.display_name ?? user.name ?? '');
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: bg,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{
        color: colors.white,
        fontFamily: fonts.bold,
        fontSize: size * 0.4,
      }}>
        {initialsFrom(user)}
      </Text>
    </View>
  );
}
