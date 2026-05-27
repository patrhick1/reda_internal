import React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { colors, fonts } from '@/lib/theme';

export type FilterOption<T extends string = string> = {
  id: T;
  label: string;
  count?: number;
};

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: FilterOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 6 }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            style={({ pressed }) => [
              {
                backgroundColor: active ? colors.black : colors.white,
                borderColor: active ? colors.black : colors.border,
                borderWidth: 1,
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 12,
                color: active ? colors.white : colors.black,
              }}
            >
              {o.label}
            </Text>
            {o.count !== undefined ? (
              <Text
                style={{
                  fontFamily: fonts.semibold,
                  fontSize: 12,
                  color: active ? colors.white : colors.textSecondary,
                  opacity: 0.85,
                }}
              >
                {o.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
