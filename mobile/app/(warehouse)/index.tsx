import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listCurrentStock, type StockMatrixRow } from '@/services/stock';
import { AppBar, Avatar, Button, Card, Empty, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { canAdjustOwnStock, canDoWarehouseTransfer, canReceiveStock } from '@/lib/permissions';

const LOW_THRESHOLD = 3;

type Group = {
  user_id: string;
  user_display_name: string;
  user_role: string;
  user_email: string;
  items: StockMatrixRow[];
  total: number;
  lowCount: number;
};

export default function WarehouseHome() {
  const router = useRouter();
  const user = useCurrentUser();
  const { data, loading, error, reload } = useAsync(() => listCurrentStock(), []);
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const groups = useMemo(() => groupByUser(data ?? []), [data]);
  const showReceive = canReceiveStock(user.role);
  const showTransfer = canDoWarehouseTransfer(user.role);
  const showAdjust = canAdjustOwnStock(user.role);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Stock"
        subtitle={`${groups.length} ${groups.length === 1 ? 'holder' : 'holders'}`}
        helpTopic="receive-stock"
      />
      {showReceive || showTransfer || showAdjust ? (
        <View
          style={{
            padding: 16,
            gap: 8,
            backgroundColor: colors.white,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          {showReceive ? (
            <Button
              variant="primary"
              full
              icon="arrowDown"
              onPress={() => router.push('/(warehouse)/receive')}
            >
              Receive stock
            </Button>
          ) : null}
          {showTransfer || showAdjust ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {showTransfer ? (
                <View style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    full
                    icon="arrowRight"
                    onPress={() => router.push('/(warehouse)/transfer')}
                  >
                    New transfer
                  </Button>
                </View>
              ) : null}
              {showAdjust ? (
                <View style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    full
                    icon="edit"
                    onPress={() => router.push('/(warehouse)/adjust')}
                  >
                    Adjustment
                  </Button>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
      <FlatList
        data={groups}
        keyExtractor={(g) => g.user_id}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={loading && !!data}
            onRefresh={reload}
            tintColor={colors.black}
          />
        }
        renderItem={({ item }) => <GroupCard group={item} />}
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="warehouse"
              title="No stock anywhere"
              sub="Bulk intakes recorded by an admin will appear here."
            />
          )
        }
      />
    </View>
  );
}

function GroupCard({ group }: { group: Group }) {
  const isWarehouse = group.user_role === 'warehouse';
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {isWarehouse ? (
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: colors.black,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="warehouse" size={22} color={colors.white} />
          </View>
        ) : (
          <Avatar user={{ display_name: group.user_display_name }} size={44} />
        )}
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}
            numberOfLines={1}
          >
            {group.user_display_name}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {group.items.length} {group.items.length === 1 ? 'product' : 'products'} · {group.total}{' '}
            items
            {group.lowCount > 0 ? (
              <Text style={{ color: colors.red, fontFamily: fonts.bold }}>
                {' '}
                · {group.lowCount} low
              </Text>
            ) : null}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: fonts.extrabold,
            fontSize: 24,
            color: colors.black,
            letterSpacing: -0.5,
          }}
        >
          {group.total}
        </Text>
      </View>
      {group.items.length > 0 ? (
        <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {group.items.slice(0, 6).map((i) => {
            const low = i.quantity_on_hand <= LOW_THRESHOLD && i.quantity_on_hand >= 0;
            const negative = i.quantity_on_hand < 0;
            const shortName = i.product_name.split(/\s+/).slice(0, 2).join(' ');
            return (
              <View
                key={i.product_catalog_id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 999,
                  borderWidth: 1,
                  backgroundColor: negative
                    ? colors.redSoft
                    : low
                      ? colors.warningSoft
                      : colors.surface,
                  borderColor: negative ? '#FCA5A5' : low ? '#FCD34D' : colors.border,
                }}
              >
                <Text
                  style={{
                    fontFamily: fonts.semibold,
                    fontSize: 11,
                    color: negative ? colors.red : low ? colors.warningDark : colors.textSecondary,
                  }}
                >
                  {shortName}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.extrabold,
                    fontSize: 11,
                    color: negative ? colors.red : low ? colors.warningDark : colors.black,
                  }}
                >
                  {i.quantity_on_hand}
                </Text>
              </View>
            );
          })}
          {group.items.length > 6 ? (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11,
                color: colors.textSecondary,
                alignSelf: 'center',
              }}
            >
              +{group.items.length - 6} more
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function groupByUser(rows: StockMatrixRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const entry = map.get(r.user_id) ?? {
      user_id: r.user_id,
      user_display_name: r.user_display_name,
      user_role: r.user_role,
      user_email: r.user_email,
      items: [],
      total: 0,
      lowCount: 0,
    };
    entry.items.push(r);
    entry.total += r.quantity_on_hand;
    if (r.quantity_on_hand <= LOW_THRESHOLD && r.quantity_on_hand >= 0) entry.lowCount++;
    map.set(r.user_id, entry);
  }
  return Array.from(map.values()).sort((a, b) => {
    // Warehouse first, then by name
    if (a.user_role === 'warehouse' && b.user_role !== 'warehouse') return -1;
    if (b.user_role === 'warehouse' && a.user_role !== 'warehouse') return 1;
    return a.user_display_name.localeCompare(b.user_display_name);
  });
}
