import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listRepClientRemit, type RepClientRemitRow } from '@/services/reconciliation';
import { AppBar, Card, Empty, FilterChips, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { formatRangeLagos, isYmd, todayLagos } from '@/lib/date';
import { detectPreset, presetRange, type Preset } from '@/lib/reconcile';

// Rep-facing reconcile: a client-only, fee-free view so reps can send clients
// their delivered-updates. Deliberately omits the admin reconcile's By-agent /
// Summary tabs, the Reda fee / cash POS fee breakdown, settlement and EOD —
// reps see delivered counts, quantities and the remit owed only.
export default function RepReconcile() {
  const router = useRouter();
  const [from, setFrom] = useState<string>(todayLagos());
  const [to, setTo] = useState<string>(todayLagos());

  // YMD gate before firing the date-typed RPC — same reason as admin reconcile:
  // typing a partial date otherwise hits PostgREST with 22007 invalid-date.
  const rangeValid = isYmd(from) && isYmd(to);
  const clientsQ = useAsync(
    () => (rangeValid ? listRepClientRemit(from, to) : Promise.resolve<RepClientRemitRow[]>([])),
    [from, to, rangeValid],
  );

  useFocusEffect(
    useCallback(() => {
      if (rangeValid) clientsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, rangeValid]),
  );

  const applyPreset = useCallback((p: Preset) => {
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  }, []);

  const rangeLabel = formatRangeLagos(from, to);
  const activePreset = detectPreset(from, to);

  const totalRemit = useMemo(
    () => (clientsQ.data ?? []).reduce((s, r) => s + Number(r.total_remit), 0),
    [clientsQ.data],
  );
  const deliveriesTotal = useMemo(
    () => (clientsQ.data ?? []).reduce((s, r) => s + Number(r.deliveries_count), 0),
    [clientsQ.data],
  );
  const count = (clientsQ.data ?? []).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Client updates" subtitle={rangeLabel} helpTopic="reconcile" />

      <View style={{ paddingTop: 12, backgroundColor: colors.surface }}>
        <FilterChips
          value={activePreset}
          onChange={(v) => applyPreset(v as Preset)}
          options={[
            { id: 'today', label: 'Today' },
            { id: 'yesterday', label: 'Yesterday' },
            { id: 'last7', label: 'Last 7 days' },
            { id: 'custom', label: 'Custom' },
          ]}
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16 }}>
        <View style={{ flex: 1 }}>
          <Input
            label="From"
            value={from}
            onChange={setFrom}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="YYYY-MM-DD"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            label="To"
            value={to}
            onChange={setTo}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="YYYY-MM-DD"
          />
        </View>
      </View>

      <FlatList
        data={clientsQ.data ?? []}
        keyExtractor={(r) => r.client_id}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={clientsQ.loading && !!clientsQ.data}
            onRefresh={clientsQ.reload}
            tintColor={colors.black}
          />
        }
        ListHeaderComponent={
          <Card style={{ marginBottom: 12 }}>
            <Text style={kicker}>Total to remit</Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 36,
                color: colors.black,
                letterSpacing: -1,
                marginTop: 4,
              }}
            >
              {formatNaira(totalRemit)}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.textSecondary,
                marginTop: 2,
              }}
            >
              {deliveriesTotal} deliveries · {count} {count === 1 ? 'client' : 'clients'}
            </Text>
          </Card>
        }
        renderItem={({ item }) => (
          <ClientRow
            row={item}
            onPress={() =>
              router.push({
                pathname: '/(rep)/reconcile/client/[id]',
                params: { id: item.client_id, name: item.client_name, from, to },
              })
            }
          />
        )}
        ListEmptyComponent={
          clientsQ.error ? (
            <Empty icon="alert" title="Could not load" sub={clientsQ.error} />
          ) : clientsQ.loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="wallet"
              title="Nothing yet"
              sub="No delivered orders for any client in this date range."
            />
          )
        }
      />
    </View>
  );
}

function ClientRow({ row, onPress }: { row: RepClientRemitRow; onPress: () => void }) {
  return (
    <Card dense style={{ padding: 0 }}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
          pressed && { opacity: 0.92 },
        ]}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: colors.black,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: fonts.extrabold, fontSize: 14, color: colors.white }}>
            {row.client_name[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {row.client_name}
          </Text>
          <Text
            style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}
            numberOfLines={1}
          >
            {row.deliveries_count} deliveries · qty {row.total_quantity}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 16,
              color: Number(row.total_remit) >= 0 ? colors.success : colors.red,
              letterSpacing: -0.2,
            }}
          >
            {formatNaira(Number(row.total_remit))}
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
            To remit
          </Text>
        </View>
        <Icon name="chevronRight" size={18} color={colors.textSecondary} />
      </Pressable>
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
