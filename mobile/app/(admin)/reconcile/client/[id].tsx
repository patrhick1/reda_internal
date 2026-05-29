import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Share, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listClientRemitDetail, type ClientRemitDetailRow } from '@/services/reconciliation';
import { AppBar, Button, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { formatDateLagos, formatRangeLagos } from '@/lib/date';

export default function ClientReconcileDetail() {
  const router = useRouter();
  const { id, name, from, to } = useLocalSearchParams<{
    id: string;
    name?: string;
    from: string;
    to: string;
  }>();

  const detailQ = useAsync<ClientRemitDetailRow[]>(
    () => listClientRemitDetail(id, from, to),
    [id, from, to],
  );

  useFocusEffect(
    useCallback(() => {
      detailQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, from, to]),
  );

  const rows = useMemo(() => detailQ.data ?? [], [detailQ.data]);

  const totals = useMemo(() => {
    let customerOwed = 0,
      paid = 0,
      redaFee = 0,
      cashPosFee = 0;
    for (const r of rows) {
      customerOwed += Number(r.customer_price ?? 0);
      paid += Number(r.paid ?? 0);
      redaFee += Number(r.reda_fee ?? 0);
      cashPosFee += Number(r.cash_pos_fee ?? 0);
    }
    return {
      count: rows.length,
      customerOwed,
      paid,
      outstanding: customerOwed - paid,
      redaFee,
      cashPosFee,
      remit: paid - redaFee - cashPosFee,
    };
  }, [rows]);

  const rangeLabel = formatRangeLagos(from, to);
  const clientName = name ?? 'Client';

  const onShare = useCallback(async () => {
    const header = [
      `Reda Logistics — ${clientName}`,
      `Period: ${rangeLabel}`,
      ``,
      `Deliveries:        ${totals.count}`,
      `Customer owed:     ${formatNaira(totals.customerOwed)}`,
      `Customer paid:     ${formatNaira(totals.paid)}`,
      `Outstanding:       ${formatNaira(totals.outstanding)}`,
      ``,
      `Reda delivery fee: ${formatNaira(totals.redaFee)}`,
      `Cash POS fee:      ${formatNaira(totals.cashPosFee)}`,
      `Remit to you:      ${formatNaira(totals.remit)}`,
    ].join('\n');

    const lines =
      rows.length === 0
        ? '(no deliveries in this range)'
        : rows
            .map((r) => {
              const qty = r.quantity_delivered != null ? `${r.quantity_delivered}× ` : '';
              const product = r.product_name ?? 'product';
              const loc = r.location_name ?? 'no location';
              const customer = r.customer_name ?? 'customer';
              const paid = formatNaira(Number(r.paid ?? 0));
              const fee = formatNaira(Number(r.reda_fee ?? 0));
              const posFee = Number(r.cash_pos_fee ?? 0);
              const posPart = posFee > 0 ? ` · POS ${formatNaira(posFee)}` : '';
              const remit = formatNaira(Number(r.remit ?? 0));
              const agent = r.agent_name ? ` (${r.agent_name.split(/\s+/)[0]})` : '';
              const date = formatDateLagos(r.scheduled_date);
              return `• ${date} · ${customer} · ${loc} · ${qty}${product}\n  collected ${paid} · Reda fee ${fee}${posPart} · remit ${remit}${agent}`;
            })
            .join('\n');

    const message = `${header}\n\nDetails:\n${lines}\n\nSent from Reda Logistics`;

    try {
      await Share.share({ message });
    } catch {
      /* user cancelled */
    }
  }, [clientName, rangeLabel, totals, rows]);

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
              <SmallRow label="Customer owed" value={formatNaira(totals.customerOwed)} />
              <SmallRow label="Customer paid" value={formatNaira(totals.paid)} />
              <SmallRow
                label="Outstanding"
                value={formatNaira(totals.outstanding)}
                accent={totals.outstanding > 0 ? colors.red : undefined}
              />
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
  const product = row.product_name ?? '—';
  const loc = row.location_name ?? '—';
  const agent = row.agent_name?.split(/\s+/)[0] ?? null;
  const qty = row.quantity_delivered;
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
            numberOfLines={1}
          >
            {product}
            {qty != null ? ` · ${qty} units` : ''}
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
        <MicroRow label="Customer paid" value={formatNaira(row.paid)} />
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
