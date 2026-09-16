import { useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { Banner, Button, Card, Empty } from '@/components/ui';
import { useSameCustomerGroups } from '@/hooks/useSameCustomer';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { formatYmdShort } from '@/lib/format';
import type { SameCustomerFilters } from '@/services/same-customer';
import { SameCustomerOrdersSheet } from '@/components/sheets/SameCustomerOrdersSheet';

export function SameCustomerOrdersList({ filters }: { filters: SameCustomerFilters }) {
  const query = useSameCustomerGroups(filters, true);
  const [groupId, setGroupId] = useState<string | null>(null);
  const groups = query.data?.pages.flatMap((page) => page.groups) ?? [];
  return (
    <>
      <FlatList
        data={groups}
        keyExtractor={(item) => item.group_id}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching && !query.isFetchingNextPage}
            onRefresh={() => void query.refetch()}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 10, paddingBottom: 10 }}>
            <Text style={{ fontFamily: fonts.semibold, color: colors.black }}>
              {query.data?.pages[0]?.total_groups ?? 0} matching groups ·{' '}
              {formatYmdShort(filters.day)}
            </Text>
            {query.error ? (
              <>
                <Banner tone="error">{errorMessage(query.error)}</Banner>
                <Button onPress={() => void query.refetch()}>Retry</Button>
              </>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Card
            onPress={() => setGroupId(item.group_id)}
            style={
              item.needs_assignment
                ? { backgroundColor: colors.warningSoft, borderColor: colors.warning }
                : undefined
            }
          >
            <View style={{ gap: 6 }}>
              <Text style={{ fontFamily: fonts.bold, color: colors.black }}>
                {item.customer_name}
              </Text>
              <Text style={{ fontFamily: fonts.semibold, color: colors.black }}>
                {item.order_count} orders · {item.vendor_count} vendors · {item.rider_count} riders
                {item.has_unassigned ? ' · Unassigned orders' : ''}
              </Text>
              <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary }}>
                {item.match_kind === 'alternate'
                  ? 'Possible match · alternate phone'
                  : item.match_kind === 'linked'
                    ? 'Customer match confirmed'
                    : 'Same phone'}
                {item.addresses_differ ? ' · Address details differ' : ''}
              </Text>
              {item.needs_assignment ? (
                <Text style={{ fontFamily: fonts.semibold, color: colors.warningDark }}>
                  Review assignment ·{' '}
                  {item.has_unassigned ? 'Unassigned orders' : 'Different riders'}
                </Text>
              ) : null}
              {item.matching_order_count < item.order_count ? (
                <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary }}>
                  {item.order_count - item.matching_order_count} related orders outside your current
                  filters
                </Text>
              ) : null}
            </View>
          </Card>
        )}
        ListEmptyComponent={
          query.isPending ? (
            <ActivityIndicator color={colors.black} />
          ) : !query.error ? (
            <Empty
              icon="search"
              title="No matching orders"
              sub="No same-customer matches for this day and these filters."
            />
          ) : null
        }
        ListFooterComponent={
          query.hasNextPage ? (
            <Button
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more groups'}
            </Button>
          ) : null
        }
      />
      {groupId ? (
        <SameCustomerOrdersSheet
          key={`${filters.day}:${groupId}`}
          day={filters.day}
          groupId={groupId}
          onClose={() => setGroupId(null)}
        />
      ) : null}
    </>
  );
}
