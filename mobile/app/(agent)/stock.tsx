import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listMyStock, type StockMatrixRow } from '@/services/stock';
import { AppBar, Card, Empty, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { isLow, isNegative } from '@/lib/stock-helpers';

export default function AgentStock() {
  const user = useCurrentUser();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => listMyStock(user.userId), [user.userId]);
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const totals = useMemo(() => {
    const rows = data ?? [];
    const total = rows.reduce((s, r) => s + r.quantity_on_hand, 0);
    return { total, count: rows.length };
  }, [data]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="My stock"
        subtitle={`${totals.total} items across ${totals.count} ${totals.count === 1 ? 'product' : 'products'}`}
        right={
          <TouchableOpacity onPress={() => router.push('/(agent)/movements')} hitSlop={8}>
            <Icon name="history" size={22} color={colors.black} />
          </TouchableOpacity>
        }
      />
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.product_catalog_id}
        renderItem={({ item }) => <StockRow row={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={loading && !!data}
            onRefresh={reload}
            tintColor={colors.black}
          />
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load stock" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="package"
              title="No stock on hand"
              sub="Stock issued by the warehouse will appear here."
            />
          )
        }
      />
    </View>
  );
}

function StockRow({ row }: { row: StockMatrixRow }) {
  const negative = isNegative(row.quantity_on_hand);
  const low = isLow(row.quantity_on_hand);
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            backgroundColor: negative ? colors.redSoft : low ? colors.warningSoft : colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name="package"
            size={20}
            color={negative ? colors.red : low ? colors.warningDark : colors.black}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
            {row.product_name}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 22,
              letterSpacing: -0.4,
              color: negative ? colors.red : low ? colors.warningDark : colors.black,
            }}
          >
            {row.quantity_on_hand}
          </Text>
          {negative ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                color: colors.red,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}
            >
              Negative
            </Text>
          ) : low ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                color: colors.warningDark,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}
            >
              Low
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
