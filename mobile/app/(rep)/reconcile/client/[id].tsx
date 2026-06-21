import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Share, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listRepClientRemitDetail, type RepClientRemitDetailRow } from '@/services/reconciliation';
import { AppBar, Button, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { formatDateLagos, formatRangeLagos, isYmd } from '@/lib/date';
import {
  buildClientShareMessage,
  deriveDeliveryNote,
  remitProductsDisplay,
  remitRowProducts,
} from '@/lib/reconcile';

// Rep-facing per-client detail. Mirrors the admin client report but with NO fee
// breakdown — only the client-facing delivered figures and the remit owed. The
// "Share with client" message is built by the shared helper, identical to the
// admin one.
export default function RepClientReconcileDetail() {
  const router = useRouter();
  const { id, name, from, to } = useLocalSearchParams<{
    id: string;
    name?: string;
    from: string;
    to: string;
  }>();

  const rangeValid = !!id && isYmd(from) && isYmd(to);
  const detailQ = useAsync<RepClientRemitDetailRow[]>(
    () => (rangeValid ? listRepClientRemitDetail(id, from, to) : Promise.resolve([])),
    [id, from, to, rangeValid],
  );

  useFocusEffect(
    useCallback(() => {
      if (rangeValid) detailQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, from, to, rangeValid]),
  );

  const rows = useMemo(() => detailQ.data ?? [], [detailQ.data]);

  const totals = useMemo(() => {
    let remit = 0;
    for (const r of rows) remit += Number(r.remit ?? 0);
    return { count: rows.length, remit };
  }, [rows]);

  const rangeLabel = formatRangeLagos(from, to);
  const clientName = name ?? 'Client';

  const onShare = useCallback(async () => {
    const message = buildClientShareMessage({
      clientName,
      rangeLabel,
      rows: rows.map((r) => ({
        customerName: r.customer_name,
        products: remitRowProducts(r),
        remit: Number(r.remit ?? 0),
        note: deriveDeliveryNote({
          quantityOrdered: r.quantity_ordered,
          quantityDelivered: r.quantity_delivered,
          outstanding: r.outstanding,
        }),
      })),
    });
    try {
      await Share.share({ message });
    } catch {
      /* user cancelled */
    }
  }, [clientName, rangeLabel, rows]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title={clientName} subtitle={rangeLabel} onBack={() => router.back()} />

      <FlatList
        data={rows}
        keyExtractor={(r) => r.delivery_id}
        contentContainerStyle={{ padding: 16, paddingBottom: 100, gap: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={detailQ.loading && !!detailQ.data}
            onRefresh={detailQ.reload}
            tintColor={colors.black}
          />
        }
        ListHeaderComponent={
          <Card style={{ marginBottom: 8 }}>
            <Text style={kicker}>Remit to {clientName}</Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 32,
                letterSpacing: -1,
                marginTop: 4,
                color: totals.remit >= 0 ? colors.success : colors.red,
              }}
            >
              {formatNaira(totals.remit)}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 4,
              }}
            >
              {totals.count} {totals.count === 1 ? 'delivery' : 'deliveries'}
            </Text>
          </Card>
        }
        renderItem={({ item }) => <DeliveryRow row={item} />}
        ListEmptyComponent={
          detailQ.error ? (
            <Empty icon="alert" title="Could not load" sub={detailQ.error} />
          ) : detailQ.loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="wallet"
              title="No deliveries"
              sub="No delivered orders for this client in this date range."
            />
          )
        }
      />

      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.white,
        }}
      >
        <Button variant="emphasis" full icon="share" onPress={onShare} disabled={rows.length === 0}>
          Share with client
        </Button>
      </View>
    </View>
  );
}

function DeliveryRow({ row }: { row: RepClientRemitDetailRow }) {
  const customer = row.customer_name ?? 'Customer';
  // Itemized so a multi-product order reads "Antivirus Cleanser ×2, Gallant Max ×5"
  // instead of the legacy collapsed "Gallant Max · 7 units".
  const products = remitProductsDisplay(remitRowProducts(row));
  const loc = row.location_name ?? '—';
  // Full display name so namesakes (e.g. "Mummy Jerry") stay distinguishable.
  const agent = row.agent_name ?? null;
  const date = formatDateLagos(row.scheduled_date);
  const remit = Number(row.remit ?? 0);
  const note = deriveDeliveryNote({
    quantityOrdered: row.quantity_ordered,
    quantityDelivered: row.quantity_delivered,
    outstanding: row.outstanding,
  });
  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
            {customer}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
            numberOfLines={2}
          >
            {products}
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
            {loc} · {date}
            {agent ? ` · ${agent}` : ''}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 16,
              color: remit >= 0 ? colors.success : colors.red,
              letterSpacing: -0.2,
            }}
          >
            {formatNaira(remit)}
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
            remit
          </Text>
        </View>
      </View>

      {note !== '—' ? (
        <View
          style={{
            marginTop: 10,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 8,
          }}
        >
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
            {note}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
