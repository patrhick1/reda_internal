import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type TabItem<T extends string = string> = {
  id: T;
  label: string;
  icon: IconName;
  badge?: number;
};

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.white,
      }}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <Pressable
            key={t.id}
            onPress={() => onChange(t.id)}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingTop: 10,
                paddingBottom: 12,
                alignItems: 'center',
                gap: 4,
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <View>
              <Icon
                name={t.icon}
                size={22}
                stroke={active ? 2.2 : 1.75}
                color={active ? colors.black : colors.textSecondary}
              />
              {t.badge ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -8,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    backgroundColor: colors.red,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 4,
                    borderWidth: 1.5,
                    borderColor: colors.white,
                  }}
                >
                  <Text style={{ color: colors.white, fontFamily: fonts.bold, fontSize: 10 }}>
                    {t.badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{
                fontFamily: active ? fonts.bold : fonts.medium,
                fontSize: 11,
                color: active ? colors.black : colors.textSecondary,
              }}
            >
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
