import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Share, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listClientRemitDetail, type ClientRemitDetailRow } from '@/services/reconciliation';
import { AppBar, Button, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { formatDateLagos, formatRangeLagos, isYmd } from '@/lib/date';
import {
  buildClientShareMessage,
  deriveDeliveryNote,
  remitProductsDisplay,
  remitRowProducts,
  remitRowQuantities,
} from '@/lib/reconcile';

export default function ClientReconcileDetail() {
  const router = useRouter();
  const { id, name, from, to } = useLocalSearchParams<{
    id: string;
    name?: string;
    from: string;
    to: string;
  }>();

  // Defensive YMD gate — same reason as the reconcile index: PostgREST 22007
  // when an invalid `from`/`to` URL param reaches the date-typed RPC.
  const rangeValid = !!id && isYmd(from) && isYmd(to);
  const detailQ = useAsync<ClientRemitDetailRow[]>(
    () => (rangeValid ? listClientRemitDetail(id, from, to) : Promise.resolve([])),
    [id, from, to, rangeValid],
  );

  useFocusEffect(
    useCallback(() => {
      if (!rangeValid) return;
      detailQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, from, to, rangeValid]),
  );

  const rows = useMemo(() => detailQ.data ?? [], [detailQ.data]);

  const totals = useMemo(() => {
    let paid = 0,
      paidToVendor = 0,
      redaFee = 0,
      cashPosFee = 0;
    for (const r of rows) {
      const cp = Number(r.customer_price ?? 0);
      const pd = Number(r.paid ?? 0);
      paid += pd;
      // vendor_direct: the customer settled the order value with the vendor
      // directly (paid-to-Reda = 0). Surfaced as its own line for clarity.
      if (r.payment_method === 'vendor_direct') paidToVendor += cp;
      redaFee += Number(r.reda_fee ?? 0);
      cashPosFee += Number(r.cash_pos_fee ?? 0);
    }
    return {
      count: rows.length,
      paid,
      paidToVendor,
      redaFee,
      cashPosFee,
      remit: paid - redaFee - cashPosFee,
    };
  }, [rows]);

  const rangeLabel = formatRangeLagos(from, to);
  const clientName = name ?? 'Client';

  const onShare = useCallback(async () => {
    // Per-delivery blocks + Total in Uzo's preferred shape, built by the shared
    // helper so the admin and rep "Share with client" output stays identical.
    const message = buildClientShareMessage({
      clientName,
      rangeLabel,
      rows: rows.map((r) => {
        const q = remitRowQuantities(r);
        return {
          customerName: r.customer_name,
          products: remitRowProducts(r),
          remit: Number(r.remit ?? 0),
          note: deriveDeliveryNote({
            quantityOrdered: q.ordered,
            quantityDelivered: q.delivered,
          }),
          paymentMethod: r.payment_method,
          cashPosFee: r.cash_pos_fee,
        };
      }),
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
              {totals.count} {totals.count === 1 ? 'delivery' : 'deliveries'} · paid − Reda fee −
              cash POS fee
            </Text>

            <View style={{ marginTop: 14, gap: 6 }}>
              <SmallRow label="Customer paid" value={formatNaira(totals.paid)} />
              {totals.paidToVendor > 0 ? (
                <SmallRow
                  label="Paid to vendor (direct)"
                  value={formatNaira(totals.paidToVendor)}
                />
              ) : null}
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
              <SmallRow label="Reda delivery fee" value={formatNaira(totals.redaFee)} />
              <SmallRow label="Cash POS fee" value={formatNaira(totals.cashPosFee)} />
            </View>
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
              sub="No delivered rows for this client in this date range."
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

function DeliveryRow({ row }: { row: ClientRemitDetailRow }) {
  const customer = row.customer_name ?? 'Customer';
  // Itemized so a multi-product order reads "Antivirus Cleanser ×2, Gallant Max ×5"
  // instead of the legacy collapsed "Gallant Max · 7 units".
  const products = remitProductsDisplay(remitRowProducts(row));
  const loc = row.location_name ?? '—';
  // Full display name so namesakes (e.g. "Mummy Jerry") stay distinguishable.
  const agent = row.agent_name ?? null;
  const date = formatDateLagos(row.scheduled_date);
  const remit = Number(row.remit ?? 0);
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

      <View
        style={{
          marginTop: 10,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: 8,
          gap: 4,
        }}
      >
        {row.payment_method === 'vendor_direct' ? (
          <MicroRow label="Paid to vendor (direct)" value={formatNaira(row.customer_price)} />
        ) : (
          <MicroRow label="Customer paid" value={formatNaira(row.paid)} />
        )}
        <MicroRow label="Reda fee" value={formatNaira(row.reda_fee)} />
        {Number(row.cash_pos_fee ?? 0) > 0 ? (
          <MicroRow label="Cash POS fee" value={formatNaira(row.cash_pos_fee)} />
        ) : null}
      </View>
    </Card>
  );
}

function SmallRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: accent ?? colors.black }}>
        {value}
      </Text>
    </View>
  );
}

function MicroRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: colors.textSecondary }}>
        {value}
      </Text>
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
