import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listAgentEarningsSummary,
  listClientRemit,
  runEodRollover,
  type AgentEarningsRow,
  type ClientRemitRow,
} from '@/services/reconciliation';
import {
  AppBar,
  Avatar,
  Button,
  Card,
  Empty,
  FilterChips,
  Hint,
  Icon,
  Input,
  Tabs,
} from '@/components/ui';
import { HINTS } from '@/hints/registry';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { daysAgoLagos, formatRangeLagos, todayLagos, yesterdayLagos } from '@/lib/date';

type Tab = 'clients' | 'agents' | 'summary';
type Preset = 'today' | 'yesterday' | 'last7' | 'custom';

function presetRange(p: Preset): { from: string; to: string } | null {
  switch (p) {
    case 'today':
      return { from: todayLagos(), to: todayLagos() };
    case 'yesterday':
      return { from: yesterdayLagos(), to: yesterdayLagos() };
    case 'last7':
      return { from: daysAgoLagos(6), to: todayLagos() };
    case 'custom':
      return null;
  }
}

function detectPreset(from: string, to: string): Preset {
  const today = todayLagos();
  const yesterday = yesterdayLagos();
  const last7 = daysAgoLagos(6);
  if (from === today && to === today) return 'today';
  if (from === yesterday && to === yesterday) return 'yesterday';
  if (from === last7 && to === today) return 'last7';
  return 'custom';
}

export default function AdminReconcile() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('clients');
  const [from, setFrom] = useState<string>(todayLagos());
  const [to, setTo] = useState<string>(todayLagos());
  const [openId, setOpenId] = useState<string | null>(null);

  const clientsQ = useAsync(() => listClientRemit(from, to), [from, to]);
  const agentsQ = useAsync(() => listAgentEarningsSummary(from, to), [from, to]);

  useFocusEffect(
    useCallback(() => {
      clientsQ.reload();
      agentsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to]),
  );

  const applyPreset = useCallback((p: Preset) => {
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  }, []);

  const onRunEod = useCallback(() => {
    const prompt = `Run end-of-day rollover?\n\nThis rolls every non-terminal delivery scheduled for ${to} forward one day.`;
    const runIt = async () => {
      try {
        const n = await runEodRollover(to);
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') window.alert(`Rolled ${n} deliveries forward.`);
        } else {
          Alert.alert('Done', `Rolled ${n} deliveries forward.`);
        }
        clientsQ.reload();
        agentsQ.reload();
      } catch (e) {
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') window.alert(`Rollover failed: ${errorMessage(e)}`);
        } else {
          Alert.alert('Rollover failed', errorMessage(e));
        }
      }
    };

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(prompt)) runIt();
      return;
    }
    Alert.alert(
      'Run end-of-day rollover?',
      `This rolls every non-terminal delivery scheduled for ${to} forward one day.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Roll forward', style: 'destructive', onPress: runIt },
      ],
    );
  }, [to, clientsQ, agentsQ]);

  const rangeLabel = formatRangeLagos(from, to);
  const activePreset = detectPreset(from, to);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Reconciliation" subtitle={rangeLabel} helpTopic="reconcile" />

      {/* Cross-cutting one-time hint: the AppBar `?` icon is new and worth
          pointing at once. Dismissing here suppresses it on every other
          helpTopic-bearing screen too (single hint id). */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Hint id={HINTS.HELP_ICON_DISCOVERY} title="Tip — In-app help">
          See the <Text style={{ fontFamily: fonts.bold }}>?</Text> in the top-right? Tap it on any
          screen to read the help for that screen. Full guide also lives in Profile → Help &amp;
          support.
        </Hint>
      </View>

      <Tabs<Tab>
        value={tab}
        tabs={[
          { id: 'clients', label: 'By client' },
          { id: 'agents', label: 'By agent' },
          { id: 'summary', label: 'Summary' },
        ]}
        onChange={setTab}
      />

      {/* Preset chips */}
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

      {/* Date range inputs — used directly when "Custom" is selected; also reflect any preset choice. */}
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

      {tab === 'clients' ? (
        <ClientsList
          state={clientsQ}
          openId={openId}
          setOpenId={setOpenId}
          onOpenClient={(c) =>
            router.push({
              pathname: '/(admin)/reconcile/client/[id]',
              params: { id: c.client_id, name: c.client_name, from, to },
            })
          }
        />
      ) : tab === 'agents' ? (
        <AgentsList state={agentsQ} openId={openId} setOpenId={setOpenId} />
      ) : (
        <SummaryTab
          clients={clientsQ.data ?? []}
          agents={agentsQ.data ?? []}
          loading={(clientsQ.loading && !clientsQ.data) || (agentsQ.loading && !agentsQ.data)}
          rangeLabel={rangeLabel}
        />
      )}

      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.white,
        }}
      >
        <Button variant="secondary" full icon="calendar" onPress={onRunEod}>
          {`Run EOD rollover for ${to}`}
        </Button>
      </View>
    </View>
  );
}

function ClientsList({
  state,
  openId,
  setOpenId,
  onOpenClient,
}: {
  state: ReturnType<typeof useAsync<ClientRemitRow[]>>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onOpenClient: (c: ClientRemitRow) => void;
}) {
  // Headline = total Reda owes back to clients across the period.
  const totalRemit = useMemo(
    () => (state.data ?? []).reduce((s, r) => s + Number(r.total_remit), 0),
    [state.data],
  );
  const count = (state.data ?? []).length;
  const deliveriesTotal = useMemo(
    () => (state.data ?? []).reduce((s, r) => s + Number(r.deliveries_count), 0),
    [state.data],
  );

  return (
    <FlatList
      data={state.data ?? []}
      keyExtractor={(r) => r.client_id}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={state.loading && !!state.data}
          onRefresh={state.reload}
          tintColor={colors.black}
        />
      }
      ListHeaderComponent={
        <Card style={{ marginBottom: 12 }}>
          <Text style={kicker}>Total remit owed</Text>
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
        <ExpandableRow
          isOpen={openId === item.client_id}
          onToggle={() => setOpenId(openId === item.client_id ? null : item.client_id)}
          onLongPress={() => onOpenClient(item)}
          onActionPress={() => onOpenClient(item)}
          subjectKind="client"
          name={item.client_name}
          countLabel={`${item.deliveries_count} deliveries · qty ${item.total_quantity}`}
          amount={Number(item.total_remit)}
          amountLabel="Remit"
          amountColor={Number(item.total_remit) >= 0 ? colors.success : colors.red}
          extra={[
            { label: 'Customer owed', value: formatNaira(item.total_customer_price) },
            { label: 'Customer paid', value: formatNaira(item.total_paid) },
            { label: 'Outstanding', value: formatNaira(item.outstanding) },
            { label: 'Reda fee', value: formatNaira(item.total_reda_fee) },
          ]}
        />
      )}
      ListEmptyComponent={
        state.error ? (
          <Empty icon="alert" title="Could not load" sub={state.error} />
        ) : state.loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <ActivityIndicator color={colors.black} />
          </View>
        ) : (
          <Empty
            icon="wallet"
            title="Nothing to remit"
            sub="No delivered rows in this date range."
          />
        )
      }
    />
  );
}

function AgentsList({
  state,
  openId,
  setOpenId,
}: {
  state: ReturnType<typeof useAsync<AgentEarningsRow[]>>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const total = useMemo(
    () => (state.data ?? []).reduce((s, r) => s + Number(r.total_earnings), 0),
    [state.data],
  );
  const count = (state.data ?? []).length;
  const deliveriesTotal = useMemo(
    () => (state.data ?? []).reduce((s, r) => s + Number(r.deliveries_count), 0),
    [state.data],
  );

  return (
    <FlatList
      data={state.data ?? []}
      keyExtractor={(r) => r.agent_id}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={state.loading && !!state.data}
          onRefresh={state.reload}
          tintColor={colors.black}
        />
      }
      ListHeaderComponent={
        <Card style={{ marginBottom: 12 }}>
          <Text style={kicker}>Total earnings owed</Text>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 36,
              color: colors.success,
              letterSpacing: -1,
              marginTop: 4,
            }}
          >
            {formatNaira(total)}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {deliveriesTotal} deliveries · {count} {count === 1 ? 'agent' : 'agents'}
          </Text>
        </Card>
      }
      renderItem={({ item }) => (
        <ExpandableRow
          isOpen={openId === item.agent_id}
          onToggle={() => setOpenId(openId === item.agent_id ? null : item.agent_id)}
          subjectKind="agent"
          name={item.agent_name}
          countLabel={`${item.deliveries_count} deliveries · qty ${item.total_quantity}`}
          amount={Number(item.total_earnings)}
          amountLabel="Earnings"
          amountColor={colors.success}
          extra={[]}
        />
      )}
      ListEmptyComponent={
        state.error ? (
          <Empty icon="alert" title="Could not load" sub={state.error} />
        ) : state.loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <ActivityIndicator color={colors.black} />
          </View>
        ) : (
          <Empty
            icon="users"
            title="No agent earnings"
            sub="No delivered rows in this date range."
          />
        )
      }
    />
  );
}

function SummaryTab({
  clients,
  agents,
  loading,
  rangeLabel,
}: {
  clients: ClientRemitRow[];
  agents: AgentEarningsRow[];
  loading: boolean;
  rangeLabel: string;
}) {
  const totals = useMemo(() => {
    const deliveries = clients.reduce((s, c) => s + Number(c.deliveries_count), 0);
    const customerOwed = clients.reduce((s, c) => s + Number(c.total_customer_price), 0);
    const customerPaid = clients.reduce((s, c) => s + Number(c.total_paid), 0);
    const outstanding = clients.reduce((s, c) => s + Number(c.outstanding), 0);
    const redaFee = clients.reduce((s, c) => s + Number(c.total_reda_fee), 0);
    const remitToClients = clients.reduce((s, c) => s + Number(c.total_remit), 0);
    const agentPayments = agents.reduce((s, a) => s + Number(a.total_earnings), 0);
    // Reda's gross income for the period = delivery fees collected.
    // Reda's net = delivery fees − agent payouts.
    const margin = redaFee - agentPayments;
    return {
      deliveries,
      customerOwed,
      customerPaid,
      outstanding,
      redaFee,
      remitToClients,
      agentPayments,
      margin,
    };
  }, [clients, agents]);

  const onShare = useCallback(async () => {
    const message = [
      `Reda Logistics — Summary`,
      `Period: ${rangeLabel}`,
      ``,
      `Deliveries:        ${totals.deliveries}`,
      `Customer owed:     ${formatNaira(totals.customerOwed)}`,
      `Customer paid:     ${formatNaira(totals.customerPaid)}`,
      `Outstanding:       ${formatNaira(totals.outstanding)}`,
      ``,
      `Reda delivery fee: ${formatNaira(totals.redaFee)}`,
      `Remit to clients:  ${formatNaira(totals.remitToClients)}`,
      `Agent payments:    ${formatNaira(totals.agentPayments)}`,
      `Reda margin:       ${formatNaira(totals.margin)}`,
    ].join('\n');
    try {
      await Share.share({ message });
    } catch {
      /* user cancelled */
    }
  }, [rangeLabel, totals]);

  if (loading) {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <ActivityIndicator color={colors.black} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Card>
        <Text style={kicker}>Period</Text>
        <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black, marginTop: 4 }}>
          {rangeLabel}
        </Text>

        <View style={{ marginTop: 16, gap: 10 }}>
          <SummaryRow label="Deliveries" value={String(totals.deliveries)} />
          <SummaryRow label="Customer owed" value={formatNaira(totals.customerOwed)} />
          <SummaryRow label="Customer paid" value={formatNaira(totals.customerPaid)} />
          <SummaryRow
            label="Outstanding"
            value={formatNaira(totals.outstanding)}
            accent={totals.outstanding > 0 ? colors.red : undefined}
          />
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
          <SummaryRow label="Reda delivery fee" value={formatNaira(totals.redaFee)} />
          <SummaryRow label="Remit to clients" value={formatNaira(totals.remitToClients)} />
          <SummaryRow label="Agent payments" value={formatNaira(totals.agentPayments)} />
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
          <SummaryRow
            label="Reda margin"
            value={formatNaira(totals.margin)}
            accent={colors.success}
            bold
          />
        </View>
      </Card>

      <View style={{ marginTop: 16 }}>
        <Button variant="emphasis" full icon="share" onPress={onShare}>
          Share summary
        </Button>
      </View>
    </View>
  );
}

function SummaryRow({
  label,
  value,
  accent,
  bold,
}: {
  label: string;
  value: string;
  accent?: string;
  bold?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: bold ? fonts.extrabold : fonts.bold,
          fontSize: bold ? 16 : 14,
          color: accent ?? colors.black,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function ExpandableRow({
  isOpen,
  onToggle,
  onLongPress,
  onActionPress,
  subjectKind,
  name,
  countLabel,
  amount,
  amountLabel,
  amountColor,
  extra,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onLongPress?: () => void;
  onActionPress?: () => void;
  subjectKind: 'client' | 'agent';
  name: string;
  countLabel: string;
  amount: number;
  amountLabel: string;
  amountColor: string;
  extra: { label: string; value: string }[];
}) {
  return (
    <Card dense style={{ padding: 0 }}>
      <Pressable
        onPress={onToggle}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          {
            padding: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          },
          pressed && { opacity: 0.92 },
        ]}
      >
        {subjectKind === 'agent' ? (
          <Avatar user={{ display_name: name }} size={36} />
        ) : (
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
              {name[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {name}
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
            {countLabel}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 16,
              color: amountColor,
              letterSpacing: -0.2,
            }}
          >
            {formatNaira(amount)}
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
            {amountLabel}
          </Text>
        </View>
        <View style={{ transform: [{ rotate: isOpen ? '90deg' : '0deg' }] }}>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </View>
      </Pressable>
      {isOpen ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.surfaceAlt,
            padding: 14,
          }}
        >
          {extra.map((e, i) => (
            <View
              key={i}
              style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}
            >
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
                {e.label}
              </Text>
              <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                {e.value}
              </Text>
            </View>
          ))}
          {onActionPress ? (
            <View style={{ marginTop: 10 }}>
              <Button variant="secondary" full icon="chevronRight" onPress={onActionPress}>
                Open report
              </Button>
            </View>
          ) : null}
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
