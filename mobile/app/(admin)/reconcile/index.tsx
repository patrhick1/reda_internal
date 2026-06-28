import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  getWaybillPaidOutTotal,
  listAgentEarningsSummary,
  listClientRemit,
  listSettlementsForDate,
  runEodRolloverAllStuck,
  settlePeriod,
  voidSettlement,
  type AgentEarningsRow,
  type ClientRemitRow,
  type SettlementRow,
  type SubjectType,
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
import { formatRangeLagos, isYmd, todayLagos } from '@/lib/date';
import {
  buildMoniepointPayoutCsv,
  buildKudaPayoutCsv,
  detectPreset,
  presetRange,
  type MoniepointPayoutRow,
  type KudaPayoutRow,
  type Preset,
} from '@/lib/reconcile';
import { kudaCodeForBankName } from '@/lib/kuda-banks';
import { listClients } from '@/services/clients';
import { downloadTextFile } from '@/lib/download';

type Tab = 'clients' | 'agents' | 'summary';

// Stable empty map so a missing settlements query doesn't allocate a new Map
// each render (which would churn the list props).
const EMPTY_SETTLEMENTS: Map<string, SettlementRow> = new Map();

export default function AdminReconcile() {
  const router = useRouter();
  const user = useCurrentUser();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const [tab, setTab] = useState<Tab>('clients');
  const [from, setFrom] = useState<string>(todayLagos());
  const [to, setTo] = useState<string>(todayLagos());
  const [openId, setOpenId] = useState<string | null>(null);

  // Gate the RPC fires behind YMD validation: the From/To Inputs call
  // setFrom/setTo on every keystroke, and the underlying RPCs take `date`
  // params — without this guard, typing "2026-06-0" hits PostgREST with
  // 22007 invalid-date-syntax and the network tab fills with 400s.
  const rangeValid = isYmd(from) && isYmd(to);
  const clientsQ = useAsync(
    () => (rangeValid ? listClientRemit(from, to) : Promise.resolve<ClientRemitRow[]>([])),
    [from, to, rangeValid],
  );
  const agentsQ = useAsync(
    () =>
      rangeValid ? listAgentEarningsSummary(from, to) : Promise.resolve<AgentEarningsRow[]>([]),
    [from, to, rangeValid],
  );
  const waybillCostsQ = useAsync(
    () => (rangeValid ? getWaybillPaidOutTotal(from, to) : Promise.resolve(0)),
    [from, to, rangeValid],
  );

  // Settlement (§14-2) is a per-DAY action, so it only applies when the range
  // is a single day (the daily-reconcile default). In multi-day ranges the
  // settle affordances are hidden — you pick a single day to settle it.
  const isSingleDay = rangeValid && from === to;
  const canSettle = user.role === 'admin' && isSingleDay;
  const settlementsQ = useAsync(
    () =>
      isSingleDay ? listSettlementsForDate(to) : Promise.resolve(new Map<string, SettlementRow>()),
    [from, to, isSingleDay],
  );

  // Vendor bank details for the Moniepoint payout CSV. Date-independent, so it
  // loads once. Includes inactive clients so a deactivated vendor still owed
  // money this day isn't silently dropped from the file.
  const clientBanksQ = useAsync(() => listClients({ includeInactive: true }), []);

  useFocusEffect(
    useCallback(() => {
      if (!rangeValid) return;
      clientsQ.reload();
      agentsQ.reload();
      waybillCostsQ.reload();
      settlementsQ.reload();
      // Bank details can be edited on another screen between visits — refresh so
      // the payout file reflects newly-added details instead of treating the
      // vendor as still missing.
      clientBanksQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, rangeValid]),
  );

  const notify = useCallback((title: string, msg: string) => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.alert(`${title}\n\n${msg}`);
    } else {
      Alert.alert(title, msg);
    }
  }, []);

  const handleSettle = useCallback(
    async (subjectType: SubjectType, subjectId: string, note: string | null) => {
      try {
        await settlePeriod(subjectType, subjectId, to, note);
        settlementsQ.reload();
      } catch (e) {
        notify('Could not settle', errorMessage(e));
      }
    },
    [to, settlementsQ, notify],
  );

  const handleVoid = useCallback(
    (settlementId: string) => {
      const run = async () => {
        try {
          await voidSettlement(settlementId, 'un-settled from reconcile');
          settlementsQ.reload();
        } catch (e) {
          notify('Could not un-settle', errorMessage(e));
        }
      };
      if (Platform.OS === 'web') {
        if (
          typeof window !== 'undefined' &&
          window.confirm(
            'Un-settle this day? The frozen record is removed (kept in the audit log).',
          )
        )
          run();
        return;
      }
      Alert.alert(
        'Un-settle?',
        'The frozen settlement record will be removed (kept in the audit log).',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Un-settle', style: 'destructive', onPress: run },
        ],
      );
    },
    [settlementsQ, notify],
  );

  const applyPreset = useCallback((p: Preset) => {
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  }, []);

  const onRunEod = useCallback(() => {
    const prompt = `Run end of day?\n\nThis releases postponed orders coming due into Unassigned, then rolls every stuck non-terminal delivery forward one day.`;
    const runIt = async () => {
      try {
        const n = await runEodRolloverAllStuck();
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
      'Run end of day?',
      `This releases postponed orders coming due into Unassigned, then rolls every stuck non-terminal delivery forward one day.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Run', style: 'destructive', onPress: runIt },
      ],
    );
  }, [clientsQ, agentsQ]);

  // Build + download the Moniepoint bulk-transfer CSV for the selected day.
  // Includes every vendor with a POSITIVE remit AND complete bank details, and
  // that is NOT already marked transferred (settled) for the day — the latter is
  // the double-payment guard: a re-download after settling won't re-pay anyone.
  // Vendors owed money but missing bank details are reported so they can be
  // fixed (they'd silently be unpaid otherwise). Web-only download.
  const onDownloadPayoutCsv = useCallback(() => {
    const remit = clientsQ.data ?? [];
    const settled = settlementsQ.data ?? EMPTY_SETTLEMENTS;
    const bankById = new Map((clientBanksQ.data ?? []).map((c) => [c.id, c] as const));
    const payable: MoniepointPayoutRow[] = [];
    const missing: string[] = [];
    let alreadySettled = 0;
    for (const r of remit) {
      const amount = Number(r.total_remit);
      if (!(amount > 0)) continue; // only positive remits get paid out
      if (settled.has(`client:${r.client_id}`)) {
        alreadySettled += 1; // already transferred — exclude to avoid double-pay
        continue;
      }
      const c = bankById.get(r.client_id);
      if (c && c.bank_account_name && c.bank_account_number && c.bank_name) {
        payable.push({
          accountName: c.bank_account_name,
          accountNumber: c.bank_account_number,
          amount,
          bank: c.bank_name,
        });
      } else {
        missing.push(r.client_name);
      }
    }
    if (payable.length === 0) {
      notify(
        'No payout file',
        missing.length
          ? `These vendors are owed money but have incomplete bank details: ${missing.join(
              ', ',
            )}.\n\nAdd their Account Name, Account Number and Bank under Catalog → Clients, then try again.`
          : alreadySettled > 0
            ? 'Every vendor owed for this day is already marked transferred — nothing left to pay.'
            : 'No vendor has a positive remit for this day.',
      );
      return;
    }
    const csv = buildMoniepointPayoutCsv(payable);
    const ok = downloadTextFile(`reda-moniepoint-payout-${to}.csv`, csv);
    if (!ok) {
      notify(
        'Use the web app',
        'The Moniepoint payout file download is available on the web app (desktop browser).',
      );
      return;
    }
    // Only surface a follow-up note when something was held back.
    const notes: string[] = [];
    if (missing.length) notes.push(`Skipped — incomplete bank details: ${missing.join(', ')}.`);
    if (alreadySettled > 0) {
      notes.push(
        `${alreadySettled} already marked transferred (excluded to avoid double payment).`,
      );
    }
    if (notes.length) {
      const total = payable.reduce((s, p) => s + p.amount, 0);
      notify(
        'Payout file downloaded',
        `${payable.length} vendor${payable.length === 1 ? '' : 's'} · ${formatNaira(
          total,
        )}.\n\n${notes.join('\n\n')}`,
      );
    }
  }, [clientsQ.data, clientBanksQ.data, settlementsQ.data, to, notify]);

  // Kuda bulk-payout CSV. Same payable filter as Moniepoint (positive remit, not
  // already settled, complete bank details), plus the stored bank name must
  // resolve to a Kuda 6-digit code — vendors whose bank we can't map are
  // reported separately rather than silently dropped. Narration = "Reda payout
  // <day>". Web-only download.
  const onDownloadKudaCsv = useCallback(() => {
    const remit = clientsQ.data ?? [];
    const settled = settlementsQ.data ?? EMPTY_SETTLEMENTS;
    const bankById = new Map((clientBanksQ.data ?? []).map((c) => [c.id, c] as const));
    const narration = `Reda payout ${to}`;
    const payable: KudaPayoutRow[] = [];
    const missing: string[] = [];
    const unmapped: string[] = [];
    let alreadySettled = 0;
    for (const r of remit) {
      const amount = Number(r.total_remit);
      if (!(amount > 0)) continue; // only positive remits get paid out
      if (settled.has(`client:${r.client_id}`)) {
        alreadySettled += 1; // already transferred — exclude to avoid double-pay
        continue;
      }
      const c = bankById.get(r.client_id);
      if (!(c && c.bank_account_name && c.bank_account_number && c.bank_name)) {
        missing.push(r.client_name);
        continue;
      }
      const bankCode = kudaCodeForBankName(c.bank_name);
      if (!bankCode) {
        unmapped.push(`${r.client_name} (${c.bank_name})`);
        continue;
      }
      payable.push({ accountNumber: c.bank_account_number, amount, bankCode, narration });
    }
    if (payable.length === 0) {
      notify(
        'No payout file',
        missing.length || unmapped.length
          ? `These vendors are owed money but can't be paid:\n${[
              ...missing,
              ...unmapped.map((u) => `${u} — bank not in Kuda's list`),
            ].join('\n')}\n\nFix bank details under Catalog → Clients, then try again.`
          : alreadySettled > 0
            ? 'Every vendor owed for this day is already marked transferred — nothing left to pay.'
            : 'No vendor has a positive remit for this day.',
      );
      return;
    }
    const csv = buildKudaPayoutCsv(payable);
    const ok = downloadTextFile(`reda-kuda-payout-${to}.csv`, csv);
    if (!ok) {
      notify(
        'Use the web app',
        'The Kuda payout file download is available on the web app (desktop browser).',
      );
      return;
    }
    const notes: string[] = [];
    if (missing.length) notes.push(`Skipped — incomplete bank details: ${missing.join(', ')}.`);
    if (unmapped.length) {
      notes.push(`Skipped — bank not in Kuda's list: ${unmapped.join(', ')}.`);
    }
    if (alreadySettled > 0) {
      notes.push(
        `${alreadySettled} already marked transferred (excluded to avoid double payment).`,
      );
    }
    if (notes.length) {
      const total = payable.reduce((s, p) => s + p.amount, 0);
      notify(
        'Payout file downloaded',
        `${payable.length} vendor${payable.length === 1 ? '' : 's'} · ${formatNaira(
          total,
        )}.\n\n${notes.join('\n\n')}`,
      );
    }
  }, [clientsQ.data, clientBanksQ.data, settlementsQ.data, to, notify]);

  const rangeLabel = formatRangeLagos(from, to);
  const activePreset = detectPreset(from, to);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Reconciliation" subtitle={rangeLabel} helpTopic="reconcile" />

      {/* Cross-cutting one-time hint: the AppBar `?` icon is new and worth
          pointing at once. Dismissing here suppresses it on every other
          helpTopic-bearing screen too (single hint id). */}
      <View style={pageSectionStyle}>
        <Hint id={HINTS.HELP_ICON_DISCOVERY} title="Tip — In-app help">
          See the <Text style={{ fontFamily: fonts.bold }}>?</Text> in the top-right? Tap it on any
          screen to read the help for that screen. Full guide also lives in Profile → Help &amp;
          support.
        </Hint>
      </View>

      <View style={pageWidthStyle}>
        <Tabs<Tab>
          value={tab}
          tabs={[
            { id: 'clients', label: 'By client' },
            { id: 'agents', label: 'By agent' },
            { id: 'summary', label: 'Summary' },
          ]}
          onChange={setTab}
        />
      </View>

      {/* Preset chips */}
      <View style={{ ...pageWidthStyle, paddingTop: 6, backgroundColor: colors.surface }}>
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
      <View
        style={{
          ...pageWidthStyle,
          flexDirection: 'row',
          gap: 12,
          paddingHorizontal: 16,
          paddingBottom: 10,
        }}
      >
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
          settlements={settlementsQ.data ?? EMPTY_SETTLEMENTS}
          canSettle={canSettle}
          showDownload={canSettle}
          isWide={isWide}
          eodDate={to}
          onDownloadCsv={onDownloadPayoutCsv}
          onDownloadKudaCsv={onDownloadKudaCsv}
          onRunEod={onRunEod}
          onSettle={(id, note) => handleSettle('client', id, note)}
          onVoid={handleVoid}
          onOpenClient={(c) =>
            router.push({
              pathname: '/(admin)/reconcile/client/[id]',
              params: { id: c.client_id, name: c.client_name, from, to },
            })
          }
        />
      ) : tab === 'agents' ? (
        <AgentsList
          state={agentsQ}
          openId={openId}
          setOpenId={setOpenId}
          settlements={settlementsQ.data ?? EMPTY_SETTLEMENTS}
          canSettle={canSettle}
          isWide={isWide}
          eodDate={to}
          onRunEod={onRunEod}
          onSettle={(id, note) => handleSettle('agent', id, note)}
          onVoid={handleVoid}
        />
      ) : (
        <SummaryTab
          clients={clientsQ.data ?? []}
          agents={agentsQ.data ?? []}
          waybillPaidOut={waybillCostsQ.data ?? 0}
          loading={
            (clientsQ.loading && !clientsQ.data) ||
            (agentsQ.loading && !agentsQ.data) ||
            (waybillCostsQ.loading && waybillCostsQ.data == null)
          }
          rangeLabel={rangeLabel}
          isWide={isWide}
          eodDate={to}
          onRunEod={onRunEod}
        />
      )}
    </View>
  );
}

function ClientsList({
  state,
  openId,
  setOpenId,
  onOpenClient,
  settlements,
  canSettle,
  showDownload,
  isWide,
  eodDate,
  onDownloadCsv,
  onDownloadKudaCsv,
  onRunEod,
  onSettle,
  onVoid,
}: {
  state: ReturnType<typeof useAsync<ClientRemitRow[]>>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onOpenClient: (c: ClientRemitRow) => void;
  settlements: Map<string, SettlementRow>;
  canSettle: boolean;
  /** Show the payout-file buttons (Moniepoint + Kuda; admin + single day). */
  showDownload?: boolean;
  isWide: boolean;
  eodDate: string;
  onDownloadCsv?: () => void;
  onDownloadKudaCsv?: () => void;
  onRunEod: () => void;
  onSettle: (subjectId: string, note: string | null) => void;
  onVoid: (settlementId: string) => void;
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
      contentContainerStyle={{ ...listContentStyle, gap: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={state.loading && !!state.data}
          onRefresh={state.reload}
          tintColor={colors.black}
        />
      }
      ListHeaderComponent={
        <View style={{ marginBottom: 12 }}>
          <Card style={{ marginBottom: showDownload && onDownloadCsv ? 10 : 0 }}>
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
          {showDownload && onDownloadCsv ? (
            <Button variant="secondary" full icon="share" onPress={onDownloadCsv}>
              {isWide ? 'Download Moniepoint payout file' : 'Download Moniepoint CSV'}
            </Button>
          ) : null}
          {showDownload && onDownloadKudaCsv ? (
            <View style={{ marginTop: 8 }}>
              <Button variant="secondary" full icon="share" onPress={onDownloadKudaCsv}>
                {isWide ? 'Download Kuda payout file' : 'Download Kuda CSV'}
              </Button>
            </View>
          ) : null}
          <View style={{ marginTop: 8 }}>
            <Button variant="secondary" full icon="calendar" onPress={onRunEod}>
              {`Run EOD rollover · ${eodDate}`}
            </Button>
          </View>
        </View>
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
          settlement={settlements.get(`client:${item.client_id}`) ?? null}
          canSettle={canSettle}
          settleLabel="Mark transferred"
          onSettle={(note) => onSettle(item.client_id, note)}
          onVoid={onVoid}
          extra={[
            { label: 'Customer paid', value: formatNaira(item.total_paid) },
            { label: 'Reda fee', value: formatNaira(item.total_reda_fee) },
            { label: 'Cash POS fee', value: formatNaira(item.total_cash_pos_fee) },
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
  settlements,
  canSettle,
  isWide,
  eodDate,
  onRunEod,
  onSettle,
  onVoid,
}: {
  state: ReturnType<typeof useAsync<AgentEarningsRow[]>>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  settlements: Map<string, SettlementRow>;
  canSettle: boolean;
  isWide: boolean;
  eodDate: string;
  onRunEod: () => void;
  onSettle: (subjectId: string, note: string | null) => void;
  onVoid: (settlementId: string) => void;
}) {
  // Headline = total cash the riders owe Reda for the period (net of their own
  // delivery pay). This is collection-from-riders, NOT agent payroll.
  const total = useMemo(
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
      keyExtractor={(r) => r.agent_id}
      contentContainerStyle={{ ...listContentStyle, gap: 8 }}
      refreshControl={
        <RefreshControl
          refreshing={state.loading && !!state.data}
          onRefresh={state.reload}
          tintColor={colors.black}
        />
      }
      ListHeaderComponent={
        <View style={{ marginBottom: 12 }}>
          <Card>
            <Text style={kicker}>Total to collect from agents</Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 36,
                // Net can go negative (riders Reda owes outweigh those who owe Reda);
                // don't render a negative total in success-green.
                color: total >= 0 ? colors.success : colors.red,
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
          <View style={{ marginTop: 8 }}>
            <Button variant="secondary" full icon="calendar" onPress={onRunEod}>
              {`${isWide ? 'Run EOD rollover' : 'Run EOD'} · ${eodDate}`}
            </Button>
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <ExpandableRow
          isOpen={openId === item.agent_id}
          onToggle={() => setOpenId(openId === item.agent_id ? null : item.agent_id)}
          subjectKind="agent"
          name={item.agent_name}
          countLabel={`${item.deliveries_count} deliveries · qty ${item.total_quantity}`}
          amount={Number(item.total_remit)}
          amountLabel="To remit"
          amountColor={Number(item.total_remit) >= 0 ? colors.success : colors.red}
          settlement={settlements.get(`agent:${item.agent_id}`) ?? null}
          canSettle={canSettle}
          settleLabel="Mark handed over"
          onSettle={(note) => onSettle(item.agent_id, note)}
          onVoid={onVoid}
          extra={[
            { label: 'Collected from customers', value: formatNaira(Number(item.total_collected)) },
            { label: 'Rider pay (kept)', value: formatNaira(Number(item.total_earnings)) },
            { label: 'To remit to Reda', value: formatNaira(Number(item.total_remit)) },
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
            icon="users"
            title="Nothing to collect"
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
  waybillPaidOut,
  loading,
  rangeLabel,
  isWide,
  eodDate,
  onRunEod,
}: {
  clients: ClientRemitRow[];
  agents: AgentEarningsRow[];
  waybillPaidOut: number;
  loading: boolean;
  rangeLabel: string;
  isWide: boolean;
  eodDate: string;
  onRunEod: () => void;
}) {
  const totals = useMemo(() => {
    const deliveries = clients.reduce((s, c) => s + Number(c.deliveries_count), 0);
    // Customer-owed / outstanding (quoted-price figures) are intentionally not
    // surfaced: Reda only ever remits what was collected, so the gap against the
    // quoted price is a customer↔vendor matter Reda never acts on.
    const customerPaid = clients.reduce((s, c) => s + Number(c.total_paid), 0);
    const redaFee = clients.reduce((s, c) => s + Number(c.total_reda_fee), 0);
    const cashPosFee = clients.reduce((s, c) => s + Number(c.total_cash_pos_fee), 0);
    const remitToClients = clients.reduce((s, c) => s + Number(c.total_remit), 0);
    const agentPayments = agents.reduce((s, a) => s + Number(a.total_earnings), 0);
    // Reda's gross income for the period = delivery fees collected.
    // Cash POS fee is a pass-through to the client (already subtracted from
    // their remit), so it does NOT contribute to Reda margin.
    // Reda's net = client charges − agent payouts − pickup/waybill costs.
    const margin = redaFee - agentPayments - waybillPaidOut;
    return {
      deliveries,
      customerPaid,
      redaFee,
      cashPosFee,
      remitToClients,
      agentPayments,
      waybillPaidOut,
      margin,
    };
  }, [clients, agents, waybillPaidOut]);

  const onShare = useCallback(async () => {
    const message = [
      `Reda Logistics — Summary`,
      `Period: ${rangeLabel}`,
      ``,
      `Deliveries:        ${totals.deliveries}`,
      `Customer paid:     ${formatNaira(totals.customerPaid)}`,
      ``,
      `Reda delivery fee: ${formatNaira(totals.redaFee)}`,
      `Cash POS fee:      ${formatNaira(totals.cashPosFee)}`,
      `Remit to clients:  ${formatNaira(totals.remitToClients)}`,
      `Agent payments:    ${formatNaira(totals.agentPayments)}`,
      `Pickup costs:      ${formatNaira(totals.waybillPaidOut)}`,
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
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={listContentStyle}
      showsVerticalScrollIndicator={false}
    >
      <Card>
        <Text style={kicker}>Period</Text>
        <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black, marginTop: 4 }}>
          {rangeLabel}
        </Text>

        <View style={{ marginTop: 16, gap: 10 }}>
          <SummaryRow label="Deliveries" value={String(totals.deliveries)} />
          <SummaryRow label="Customer paid" value={formatNaira(totals.customerPaid)} />
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
          <SummaryRow label="Reda delivery fee" value={formatNaira(totals.redaFee)} />
          <SummaryRow label="Cash POS fee" value={formatNaira(totals.cashPosFee)} />
          <SummaryRow label="Remit to clients" value={formatNaira(totals.remitToClients)} />
          <SummaryRow label="Agent payments" value={formatNaira(totals.agentPayments)} />
          <SummaryRow label="Pickup / waybill costs" value={formatNaira(totals.waybillPaidOut)} />
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
          <SummaryRow
            label="Reda margin"
            value={formatNaira(totals.margin)}
            accent={colors.success}
            bold
          />
        </View>
      </Card>

      <View
        style={{
          marginTop: 12,
          flexDirection: isWide ? 'row' : 'column',
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Button variant="emphasis" full icon="share" onPress={onShare}>
            Share summary
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" full icon="calendar" onPress={onRunEod}>
            {`Run EOD rollover · ${eodDate}`}
          </Button>
        </View>
      </View>
    </ScrollView>
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
  settlement,
  canSettle,
  settleLabel,
  onSettle,
  onVoid,
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
  settlement?: SettlementRow | null;
  canSettle?: boolean;
  settleLabel?: string;
  onSettle?: (note: string | null) => void;
  onVoid?: (settlementId: string) => void;
}) {
  const [note, setNote] = useState('');
  // amount = the live remit figure. Drift = live − the amount frozen at settle.
  const settledAmount = settlement ? Number(settlement.expected_amount) : null;
  const drift = settledAmount != null ? amount - settledAmount : 0;
  const hasDrift = settledAmount != null && Math.abs(drift) > 0.005;
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
          {settlement ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginTop: 3,
                color: hasDrift ? colors.warning : colors.success,
              }}
            >
              {hasDrift ? '⚠ changed' : '✓ settled'}
            </Text>
          ) : null}
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
          {/* Settlement (§14-2): freeze this subject-day, or show the frozen
              record + any drift since it was settled. Single-day mode only. */}
          {settlement ? (
            <View
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              <Text
                style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary }}
              >
                {`Settled ${formatNaira(settledAmount ?? 0)}${
                  settlement.settled_by_name ? ` · ${settlement.settled_by_name}` : ''
                }`}
              </Text>
              {settlement.note ? (
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                >
                  {`Ref: ${settlement.note}`}
                </Text>
              ) : null}
              {hasDrift ? (
                <View
                  style={{
                    marginTop: 8,
                    backgroundColor: colors.warningSoft,
                    borderRadius: 10,
                    padding: 10,
                  }}
                >
                  <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: colors.warningDark }}>
                    Changed since settled
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.warningDarker,
                      marginTop: 2,
                    }}
                  >
                    {`Was ${formatNaira(settledAmount ?? 0)} when settled · now ${formatNaira(
                      amount,
                    )} (${drift > 0 ? '+' : ''}${formatNaira(
                      drift,
                    )}). Reconcile the difference on the next transfer.`}
                  </Text>
                </View>
              ) : null}
              {canSettle && onVoid ? (
                <View style={{ marginTop: 10 }}>
                  <Button
                    variant="secondary"
                    full
                    icon="x"
                    onPress={() => onVoid(settlement.settlement_id)}
                  >
                    Un-settle
                  </Button>
                </View>
              ) : null}
            </View>
          ) : canSettle && onSettle ? (
            <View
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                gap: 10,
              }}
            >
              <Input
                label={subjectKind === 'client' ? 'Bank ref / note (optional)' : 'Note (optional)'}
                value={note}
                onChange={setNote}
                autoCapitalize="none"
                placeholder={subjectKind === 'client' ? 'e.g. GTB transfer 14:32' : 'optional'}
              />
              <Button
                variant="emphasis"
                full
                icon="check"
                onPress={() => onSettle(note.trim() || null)}
              >
                {settleLabel ?? 'Mark settled'}
              </Button>
            </View>
          ) : null}
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

const pageWidthStyle = {
  width: '100%' as const,
  maxWidth: 1200,
  alignSelf: 'center' as const,
};

const pageSectionStyle = {
  ...pageWidthStyle,
  paddingHorizontal: 16,
  paddingTop: 12,
};

const listContentStyle = {
  ...pageWidthStyle,
  padding: 16,
  paddingBottom: 32,
};
