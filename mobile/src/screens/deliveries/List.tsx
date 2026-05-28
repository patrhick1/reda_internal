import { memo, useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, type DeliveryRow } from '@/services/deliveries';
import { listActiveFollowups, type ActiveFollowup } from '@/services/followups';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { listUsers, type AppUser } from '@/services/users';
import { canAssignDelivery, canCreateDelivery, canSeeClientName } from '@/lib/permissions';
import { formatNaira } from '@/lib/format';
import {
  AppBar,
  Avatar,
  Card,
  Empty,
  FAB,
  FilterChips,
  Icon,
  Input,
  StatusPill,
} from '@/components/ui';
import { colors, fonts, statusBucket, STATUS_GROUPS } from '@/lib/theme';
import { todayLagos, yesterdayLagos } from '@/lib/date';

const SOFT_STATUSES = new Set<string>(STATUS_GROUPS.soft);

type BasePath = '/(admin)' | '/(dispatcher)' | '/(rep)';
type Filter = 'all' | 'active' | 'available' | 'soft' | 'done' | 'unassigned';
type DatePreset = 'today' | 'yesterday' | 'custom' | 'all';

export function DeliveriesList({ basePath }: { basePath: BasePath }) {
  const user = useCurrentUser();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  // Persists across preset toggles so switching today → yesterday → custom
  // doesn't blank the value the user already typed.
  const [customDate, setCustomDate] = useState<string>(todayLagos());
  // null = "All agents". Agents see only their own deliveries server-side,
  // so the picker stays hidden for them — narrowing has no work to do.
  const [agentId, setAgentId] = useState<string | null>(null);
  const showAgentPicker = canAssignDelivery(user.role);
  // Reps coordinate with vendors and need the client name on each row so they
  // can scan and call back without opening the detail. Agents have a separate
  // screen (`(agent)/today/index.tsx`) — this gate is defensive in case the
  // shared list is ever wired into an agent route.
  const showClient = canSeeClientName(user.role);
  // Customer-name substring filter. Ops roles (admin / dispatcher / rep) —
  // agents have at most a handful of rows on screen and don't need it. Plain
  // client-side narrow over the already-fetched list; no extra round-trip.
  const showNameSearch = canAssignDelivery(user.role);
  const [nameQuery, setNameQuery] = useState('');
  const nameNeedle = nameQuery.trim().toLowerCase();

  // Derive the filter passed to the service. Mirrors the reconcile pattern.
  const listFilters = useMemo(() => {
    switch (datePreset) {
      case 'today':
        return { date: todayLagos() };
      case 'yesterday':
        return { date: yesterdayLagos() };
      case 'custom':
        return { date: customDate };
      case 'all':
        return { allDates: true };
    }
  }, [datePreset, customDate]);

  const { data, loading, error, reload } = useAsync(
    () => listDeliveries(user.role, listFilters),
    [user.role, datePreset, customDate],
  );

  // Active follow-up claims, fetched only for the ops set (admin / dispatcher /
  // rep — agents don't see the claim overlay in v1). Paired with the
  // deliveries reload so both stay in sync on focus + pull-to-refresh.
  const canSeeClaims = user.role === 'admin' || user.role === 'dispatcher' || user.role === 'rep';
  const followupsQ = useAsync<ActiveFollowup[]>(
    () => (canSeeClaims ? listActiveFollowups() : Promise.resolve([])),
    [canSeeClaims],
  );

  // Roster for the agent picker. Skip the fetch entirely when the picker
  // won't render (agents). Cached for the screen's lifetime — agents don't
  // get added/deactivated mid-session in practice.
  const agentsQ = useAsync<AppUser[]>(
    () => (showAgentPicker ? listUsers() : Promise.resolve([])),
    [showAgentPicker],
  );
  const agents = useMemo(() => {
    return (agentsQ.data ?? [])
      .filter((u) => u.role === 'agent' && u.is_active)
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
  }, [agentsQ.data]);

  useFocusEffect(
    useCallback(() => {
      reload();
      if (canSeeClaims) followupsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reload, canSeeClaims]),
  );

  // Realtime: keep the per-row claimer avatar pill live for the ops set.
  // Mirrors FollowupClaimBanner's per-delivery sub but unfiltered at the
  // screen level — one channel covers every row. Pairs with
  // scripts/delivery-followups-realtime.sql which adds the table to the
  // supabase_realtime publication.
  useSupabaseChannel(
    canSeeClaims ? 'deliveries-list-followups' : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_followups' },
        () => {
          followupsQ.reload();
        },
      ),
    [canSeeClaims],
  );

  const followupByDelivery = useMemo(() => {
    const m = new Map<string, ActiveFollowup>();
    for (const f of followupsQ.data ?? []) m.set(f.delivery_id, f);
    return m;
  }, [followupsQ.data]);

  // Narrow by agent + customer-name FIRST so the status segment counts
  // (Active/Soft/Done/Unassigned) reflect just the slice the user is looking
  // at — matches the intent of "show me Tunde's pending for Mr Adeyemi".
  // When agentId is set, the Unassigned count is 0 by definition (an
  // unassigned delivery has no agent). Name match is a case-insensitive
  // substring on customer_name.
  const all = useMemo(() => {
    let rows = data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (nameNeedle)
      rows = rows.filter((d) => (d.customer_name ?? '').toLowerCase().includes(nameNeedle));
    return rows;
  }, [data, agentId, nameNeedle]);
  const buckets = useMemo(
    () => ({
      all,
      active: all.filter((d) => statusBucket(d.current_status) === 'active'),
      available: all.filter((d) => d.current_status === 'available'),
      soft: all.filter((d) => statusBucket(d.current_status) === 'soft'),
      done: all.filter((d) => statusBucket(d.current_status) === 'done'),
      unassigned: all.filter((d) => !d.assigned_agent_id),
    }),
    [all],
  );

  const list = buckets[filter];
  const filterOptions = [
    { id: 'all' as const, label: 'All', count: buckets.all.length },
    { id: 'active' as const, label: 'Active', count: buckets.active.length },
    { id: 'available' as const, label: 'Available', count: buckets.available.length },
    { id: 'soft' as const, label: 'Soft fail', count: buckets.soft.length },
    { id: 'done' as const, label: 'Done', count: buckets.done.length },
    { id: 'unassigned' as const, label: 'Unassigned', count: buckets.unassigned.length },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Deliveries" subtitle={subtitleFor(datePreset, customDate)} />
      <View
        style={{
          backgroundColor: colors.white,
          paddingTop: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <FilterChips
          options={DATE_OPTIONS}
          value={datePreset}
          onChange={(v) => setDatePreset(v as DatePreset)}
        />
        {datePreset === 'custom' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <Input
              label="Date"
              value={customDate}
              onChange={setCustomDate}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="YYYY-MM-DD"
            />
          </View>
        ) : null}
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
        {showNameSearch ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
            <Input
              icon="search"
              value={nameQuery}
              onChange={setNameQuery}
              placeholder="Search customer name"
              autoCapitalize="none"
              autoCorrect={false}
              rightAdornment={
                nameQuery ? (
                  <Pressable
                    onPress={() => setNameQuery('')}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                    hitSlop={8}
                  >
                    <Icon name="x" size={16} color={colors.textSecondary} />
                  </Pressable>
                ) : null
              }
            />
          </View>
        ) : null}
        {showAgentPicker ? (
          <AgentPicker
            value={agentId}
            agents={agents}
            loading={agentsQ.loading}
            onChange={setAgentId}
          />
        ) : null}
      </View>
      <FlatList
        data={list}
        keyExtractor={keyForDelivery}
        renderItem={({ item }) => {
          const claim = item.id ? followupByDelivery.get(item.id) : undefined;
          return (
            <DeliveryListRow
              delivery={item}
              followup={claim}
              showClient={showClient}
              onPress={() =>
                router.push({
                  pathname: `${basePath}/deliveries/[id]` as
                    | `/(admin)/deliveries/[id]`
                    | `/(dispatcher)/deliveries/[id]`
                    | `/(rep)/deliveries/[id]`,
                  params: { id: item.id ?? '' },
                })
              }
            />
          );
        }}
        ItemSeparatorComponent={SeparatorH8}
        refreshControl={
          <RefreshControl
            refreshing={loading && !!data}
            onRefresh={reload}
            tintColor={colors.black}
          />
        }
        contentContainerStyle={{ padding: 16, paddingBottom: 96, flexGrow: 1 }}
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="package"
              title="Nothing here"
              sub={emptySubtitle(
                datePreset,
                customDate,
                agents.find((a) => a.id === agentId)?.display_name ?? null,
                nameQuery.trim() || null,
              )}
            />
          )
        }
      />
      {canCreateDelivery(user.role) ? (
        <FAB
          icon="plus"
          label="Create"
          onPress={() =>
            router.push(
              `${basePath}/deliveries/new` as
                | `/(admin)/deliveries/new`
                | `/(dispatcher)/deliveries/new`,
            )
          }
        />
      ) : null}
    </View>
  );
}

// Memoised so unchanged rows don't re-render when the parent re-creates
// renderItem closures on filter switches.
const DeliveryListRow = memo(function DeliveryListRow({
  delivery,
  onPress,
  followup,
  showClient,
}: {
  delivery: DeliveryRow;
  onPress: () => void;
  followup?: ActiveFollowup;
  showClient: boolean;
}) {
  const status = delivery.current_status ?? 'pending';
  const showFollowup = followup && SOFT_STATUSES.has(status);
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          {showClient && delivery.client_name ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: colors.textSecondary,
                marginBottom: 2,
              }}
              numberOfLines={1}
            >
              {delivery.client_name}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text
              style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
              numberOfLines={1}
            >
              {delivery.customer_name}
            </Text>
            {showFollowup ? (
              <View
                accessibilityLabel={`${followup!.holder_name} is handling the follow-up`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: colors.infoSoft,
                  borderRadius: 999,
                }}
              >
                <Avatar user={{ display_name: followup!.holder_name }} size={16} />
                <Text style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.infoDark }}>
                  {followup!.holder_name.split(/\s+/)[0]}
                </Text>
              </View>
            ) : null}
            {delivery.latest_notified ? (
              <View
                accessibilityLabel="Client has been notified of the latest status"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: colors.successSoft,
                  borderRadius: 999,
                }}
              >
                <Icon name="check" size={10} color={colors.successDark} />
                <Text
                  style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.successDark }}
                >
                  Notified
                </Text>
              </View>
            ) : null}
            <StatusPill status={status} variant="subtle" size="sm" />
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
            {delivery.product_name ?? '—'}
            {delivery.location_name ? ` · ${delivery.location_name}` : ` · `}
            {!delivery.location_name ? (
              <Text style={{ color: colors.red, fontFamily: fonts.bold }}>Unmatched</Text>
            ) : null}
          </Text>
          <View
            style={{
              marginTop: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {delivery.assigned_agent_name ? (
                <>
                  <Avatar user={{ display_name: delivery.assigned_agent_name }} size={20} />
                  <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.black }}>
                    {delivery.assigned_agent_name.split(/\s+/)[0]}
                  </Text>
                </>
              ) : (
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: 11,
                    color: colors.red,
                    letterSpacing: 0.6,
                    textTransform: 'uppercase',
                  }}
                >
                  Unassigned
                </Text>
              )}
            </View>
            <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
              {formatNaira(delivery.customer_price)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
});

// Stable references for FlatList — passing fresh inline functions/objects
// every render defeats the virtualiser's diff.
function keyForDelivery(d: DeliveryRow): string {
  return d.id ?? Math.random().toString();
}
function SeparatorH8() {
  return <View style={{ height: 8 }} />;
}

const DATE_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'custom', label: 'Custom' },
  { id: 'all', label: 'All dates' },
];

function subtitleFor(preset: DatePreset, customDate: string): string {
  switch (preset) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'custom':
      return customDate;
    case 'all':
      return 'All dates';
  }
}

function emptySubtitle(
  preset: DatePreset,
  customDate: string,
  agentName: string | null,
  nameQuery: string | null,
): string {
  const when =
    preset === 'today'
      ? 'today'
      : preset === 'yesterday'
        ? 'yesterday'
        : preset === 'custom'
          ? customDate
          : 'any date';
  if (nameQuery && agentName) {
    return `No deliveries matching "${nameQuery}" for ${agentName} on ${when}. Try clearing the search or agent filter.`;
  }
  if (nameQuery) {
    return `No deliveries matching "${nameQuery}" on ${when}. Try clearing the search or switching dates.`;
  }
  if (agentName) {
    return `No deliveries for ${agentName} on ${when}. Try clearing the agent filter or switching dates.`;
  }
  switch (preset) {
    case 'today':
      return 'No deliveries scheduled for today. New orders show up here when the bot creates them or you add one with the red + button.';
    case 'yesterday':
      return 'No deliveries scheduled for yesterday.';
    case 'custom':
      return `No deliveries scheduled for ${customDate}. Try a different date.`;
    case 'all':
      return 'No deliveries yet across all dates. Switch filters above or tap the red + button to create one.';
  }
}

/** Compact dropdown that opens a bottom-sheet list of active agents.
 *  Admin + dispatcher only — gated by `canAssignDelivery(role)` at the call
 *  site. `value=null` means "All agents". No "Unassigned" entry — that's the
 *  status segment's job; keeping them orthogonal avoids two paths to the
 *  same filter. */
function AgentPicker({
  value,
  agents,
  onChange,
  loading,
}: {
  value: string | null;
  agents: AppUser[];
  onChange: (v: string | null) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = agents.find((a) => a.id === value) ?? null;
  const triggerLabel = loading
    ? 'Loading agents…'
    : selected
      ? `Agent: ${selected.display_name}`
      : 'Agent: All agents';
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          if (!loading) setOpen(true);
        }}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Filter by agent"
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.white,
          },
          pressed && { opacity: 0.9 },
        ]}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontFamily: fonts.semibold,
            fontSize: 13,
            color: selected ? colors.black : colors.textSecondary,
          }}
        >
          {triggerLabel}
        </Text>
        <Icon name="chevronDown" size={16} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(10,10,10,0.42)', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: colors.white,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingBottom: 24,
              maxHeight: '70%',
            }}
            onPress={() => undefined}
          >
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <View
                style={{ width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2 }}
              />
            </View>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 13,
                color: colors.textSecondary,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                paddingHorizontal: 20,
                paddingTop: 8,
                paddingBottom: 8,
              }}
            >
              Filter by agent
            </Text>
            <FlatList
              data={[null as string | null, ...agents.map((a) => a.id)]}
              keyExtractor={(v) => v ?? '__all__'}
              renderItem={({ item }) => {
                const a = item ? agents.find((x) => x.id === item) : null;
                const label = a ? a.display_name : 'All agents';
                const active = (value ?? null) === item;
                return (
                  <Pressable
                    onPress={() => {
                      onChange(item);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingVertical: 14,
                      },
                      active && { backgroundColor: colors.surface },
                      pressed && { opacity: 0.88 },
                    ]}
                  >
                    <Text
                      style={{
                        flex: 1,
                        fontFamily: fonts.semibold,
                        fontSize: 15,
                        color: colors.black,
                      }}
                    >
                      {label}
                    </Text>
                    {active ? <Icon name="check" size={18} color={colors.black} /> : null}
                  </Pressable>
                );
              }}
              ItemSeparatorComponent={() => (
                <View style={{ height: 1, backgroundColor: colors.border }} />
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
