import { Pressable, Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';

export type TabsItem<T extends string> = { id: T; label: string };

export type TabsProps<T extends string> = {
  value: T;
  tabs: readonly TabsItem<T>[];
  onChange: (next: T) => void;
};

/**
 * Segmented control rendered as a row of Pressable items with an active
 * red underline. Pattern lifted from the original inline reconcile-screen
 * tab strip — extracted here so other admin screens (stock, etc.) can reuse
 * the same look without re-pasting.
 */
export function Tabs<T extends string>({ value, tabs, onChange }: TabsProps<T>) {
  return (
    <View style={{
      flexDirection: 'row',
      gap: 24,
      paddingHorizontal: 16,
      backgroundColor: colors.white,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    }}>
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <Pressable
            key={t.id}
            onPress={() => onChange(t.id)}
            style={{
              paddingVertical: 14,
              borderBottomWidth: 2,
              borderBottomColor: active ? colors.red : 'transparent',
              marginBottom: -1,
            }}
          >
            <Text style={{
              fontFamily: fonts.bold,
              fontSize: 14,
              color: active ? colors.black : colors.textSecondary,
            }}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
