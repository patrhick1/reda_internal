// One vendor's stock roll-up as a tappable card. Shared by the Stock Overview
// "By client" tab and the warehouse By-client screen so the two read identically
// and can't drift. Read-only; the caller wires `onPress` (drill into the
// per-client detail).
import { Pressable, Text, View } from 'react-native';
import { Card, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import type { ClientStockGroup } from '@/services/stock';

export function ClientStockCard({
  group,
  onPress,
}: {
  group: ClientStockGroup;
  onPress: () => void;
}) {
  const outOfStock = group.total_qty === 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
              {group.client_name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 2,
              }}
            >
              {outOfStock
                ? 'Nothing in stock right now'
                : `${group.products_count} ${group.products_count === 1 ? 'product' : 'products'} · ${group.warehouse_qty} warehouse · ${group.agents_qty} with agents`}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 20,
                letterSpacing: -0.5,
                color: outOfStock ? colors.red : colors.black,
              }}
            >
              {group.total_qty}
            </Text>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                color: colors.textSecondary,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                marginTop: 2,
              }}
            >
              total
            </Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </View>
      </Card>
    </Pressable>
  );
}
