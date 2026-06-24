// Admin-only "Negative margin" review list. Every live delivery whose
// snapshotted Reda charge is below the agent payout (deliveries_admin.margin
// < 0) — typically a row where a client charge cap clamped the charge below
// the location's agent fee. Tapping a row opens its detail, where an admin
// corrects the charges (CorrectChargesSheet). The list is a pure margin < 0
// filter, so a corrected row drops off automatically.
//
// Reached from a "Needs attention" row on the admin Home; registered as a
// hidden tab in (admin)/_layout.tsx. The (admin) group already gates to admins;
// deliveries_admin independently enforces is_admin().
import { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  deliveryProductsLabel,
  listNegativeMarginDeliveries,
  type DeliveryRow,
} from '@/services/deliveries';
import { AppBar, Card, Empty, Icon, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';

export default function AdminNegativeMargin() {
  const router = useRouter();
  const rowsQ = useAsync<DeliveryRow[]>(() => listNegativeMarginDeliveries(), []);

  useFocusEffect(
    useCallback(() => {
      rowsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const rows = rowsQ.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Negative margin"
        subtitle={rows.length > 0 ? `${rows.length} to review` : undefined}
        onBack={() => router.back()}
      />
      {rowsQ.loading && !rowsQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : rowsQ.error ? (
        <Empty icon="alert" title="Could not load" sub={rowsQ.error} />
      ) : rows.length === 0 ? (
        <Empty
          icon="check"
          title="No negative-margin orders"
          sub="Every delivery collects at least what it pays the agent."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(d) => d.id ?? Math.random().toString()}
          contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={rowsQ.loading && !!rowsQ.data}
              onRefresh={rowsQ.reload}
              tintColor={colors.black}
            />
          }
          ListHeaderComponent={
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                padding: 12,
                marginBottom: 8,
                borderRadius: 10,
                backgroundColor: colors.redSoft,
              }}
            >
              <Icon name="alert" size={18} color={colors.red} />
              <Text
                style={{
                  flex: 1,
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.red,
                  lineHeight: 16,
                }}
              >
                These orders pay the agent more than Reda collects. Open one to correct the charges.
              </Text>
            </View>
          }
          renderItem={({ item: d }) => {
            const charged = 'charged_snapshot' in d ? (d.charged_snapshot ?? null) : null;
            return (
              <Card
                dense
                onPress={() =>
                  router.push({ pathname: '/(admin)/deliveries/[id]', params: { id: d.id! } })
                }
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text
                        style={{
                          flex: 1,
                          fontFamily: fonts.bold,
                          fontSize: 14,
                          color: colors.black,
                        }}
                        numberOfLines={1}
                      >
                        {d.customer_name}
                      </Text>
                      <StatusPill
                        status={d.current_status ?? 'pending'}
                        variant="subtle"
                        size="sm"
                      />
                    </View>
                    <Text
                      style={{
                        fontFamily: fonts.medium,
                        fontSize: 12,
                        color: colors.textSecondary,
                        marginTop: 2,
                      }}
                      numberOfLines={1}
                    >
                      {deliveryProductsLabel(d)} · {d.client_name ?? 'No vendor'}
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
                      Charge {formatNaira(charged)} · Agent {formatNaira(d.agent_payment_snapshot)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontFamily: fonts.extrabold, fontSize: 16, color: colors.red }}>
                      {formatNaira(d.margin)}
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
                      Margin
                    </Text>
                  </View>
                </View>
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}
