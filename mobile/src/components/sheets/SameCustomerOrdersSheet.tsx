import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { useUsers } from '@/hooks/queries';
import { useSameCustomerDetails } from '@/hooks/useSameCustomer';
import { Banner, Button, Card, Icon, Input, Sheet, StatusPill } from '@/components/ui';
import { colors, fonts, TERMINAL_STATUSES } from '@/lib/theme';
import { canCorrectCustomerMatch } from '@/lib/permissions';
import { formatNaira, formatYmdShort } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { newClientUuid } from '@/lib/uuid';
import {
  assignSameCustomerOrders,
  correctSameCustomerMatch,
  type SameCustomerAssignment,
} from '@/services/same-customer';

/** Mounted with a day/group key by callers so selections never cross groups. */
export function SameCustomerOrdersSheet({
  day,
  groupId,
  onClose,
}: {
  day: string;
  groupId: string;
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const router = useRouter();
  const canManage = canCorrectCustomerMatch(user.role);
  const details = useSameCustomerDetails(day, groupId, true);
  const users = useUsers({ enabled: canManage });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [chooseRider, setChooseRider] = useState(false);
  const [riderSearch, setRiderSearch] = useState('');
  const [action, setAction] = useState<'link' | 'split' | 'reset' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignment, setAssignment] = useState<SameCustomerAssignment | null>(null);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const orders = details.data?.orders ?? [];
  const selectedOrders = orders.filter((order) => selected.has(order.id));
  const hasOpenSelection = selectedOrders.some((order) => !TERMINAL_STATUSES.has(order.status));
  const agents = (users.data ?? []).filter(
    (agent) =>
      agent.role === 'agent' &&
      agent.is_active &&
      !agent.parent_agent_id &&
      agent.display_name.toLowerCase().includes(riderSearch.trim().toLowerCase()),
  );
  function requestId(payload: unknown) {
    const key = JSON.stringify(payload);
    if (request.current?.payload !== key) request.current = { payload: key, id: newClientUuid() };
    return request.current.id;
  }
  async function assign(agentId: string) {
    const ids = selectedOrders.map((order) => order.id).sort();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await assignSameCustomerOrders(requestId({ ids, agentId }), ids, agentId);
      setAssignment(result);
      setChooseRider(false);
      setSelected(new Set());
      setNotice(
        `${result.updated_count} ${result.updated_count === 1 ? 'delivery assigned' : 'deliveries assigned'}.`,
      );
      await details.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    if (!action || !reason.trim() || !selectedOrders.length) return;
    const input = {
      action,
      reason: reason.trim(),
      orders: selectedOrders.map(({ id, revision }) => ({ id, revision })),
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await correctSameCustomerMatch({ ...input, requestId: requestId(input) });
      setNotice('Customer match corrected.');
      setSelected(new Set());
      setAction(null);
      setReason('');
      await details.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const base =
    user.role === 'admin' ? '/(admin)' : user.role === 'dispatcher' ? '/(dispatcher)' : '/(rep)';
  return (
    <Sheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={details.data?.match_kind === 'single' ? 'Customer match correction' : 'Same customer'}
      subtitle={formatYmdShort(day)}
      footer={
        <Button variant="secondary" full disabled={busy} onPress={onClose}>
          Close
        </Button>
      }
    >
      <View style={{ padding: 16, gap: 14 }}>
        {details.isPending ? <ActivityIndicator color={colors.black} /> : null}
        {details.error ? (
          <>
            <Banner tone="error">{errorMessage(details.error)}</Banner>
            <Button onPress={() => void details.refetch()}>Retry</Button>
          </>
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {assignment
          ? assignment.orders.map((row) => (
              <Text
                key={row.delivery_id}
                style={{ fontFamily: fonts.medium, color: colors.textSecondary }}
              >
                #{row.delivery_id.slice(0, 8)} ·{' '}
                {row.outcome === 'already_assigned'
                  ? 'Already with this rider'
                  : row.outcome === 'closed'
                    ? 'Closed — assignment unchanged'
                    : row.outcome === 'unavailable'
                      ? 'Unavailable — not assigned'
                      : 'Assigned'}
              </Text>
            ))
          : null}
        {!details.isPending && !details.error && !details.data ? (
          <Banner tone="info">
            These orders no longer form this group. Close this panel to see the updated matches.
          </Banner>
        ) : null}
        {details.data ? (
          <>
            <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary }}>
              {details.data.match_kind === 'alternate'
                ? 'Possible match through an alternate phone. Check the recipient details.'
                : details.data.match_kind === 'linked'
                  ? 'Operations linked these orders to the same customer.'
                  : details.data.match_kind === 'single'
                    ? orders.some((order) => order.match_mode !== 'auto')
                      ? 'This order has a manual customer-match correction. Select it to restore automatic phone matching.'
                      : 'This order uses automatic phone matching. No manual correction remains.'
                    : 'These orders share the same phone number.'}{' '}
              {details.data.match_kind !== 'single'
                ? 'Select orders to manage them. Each order keeps its own outcome and payment.'
                : ''}
            </Text>
            {orders.map((order) => (
              <Card key={order.id} dense>
                <View style={{ gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {canManage &&
                    (details.data?.match_kind !== 'single' || order.match_mode !== 'auto') ? (
                      <Pressable
                        accessibilityRole="checkbox"
                        aria-checked={selected.has(order.id)}
                        accessibilityLabel={`Select ${order.client_name}, ${order.customer_name}`}
                        accessibilityState={{ checked: selected.has(order.id), disabled: busy }}
                        disabled={busy}
                        onPress={() =>
                          setSelected((old) => {
                            const next = new Set(old);
                            if (next.has(order.id)) next.delete(order.id);
                            else next.add(order.id);
                            return next;
                          })
                        }
                        style={{
                          padding: 10,
                          minWidth: 44,
                          minHeight: 44,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <View
                          style={{
                            width: 22,
                            height: 22,
                            borderWidth: 2,
                            borderColor: selected.has(order.id)
                              ? colors.black
                              : colors.textSecondary,
                            borderRadius: 4,
                            backgroundColor: selected.has(order.id) ? colors.black : colors.white,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {selected.has(order.id) ? (
                            <Icon name="check" size={14} color={colors.white} />
                          ) : null}
                        </View>
                      </Pressable>
                    ) : null}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: fonts.bold, color: colors.black }}>
                        {order.client_name}
                      </Text>
                      <Text style={{ fontFamily: fonts.medium, color: colors.black }}>
                        {order.customer_name}
                      </Text>
                    </View>
                    <StatusPill status={order.status} />
                  </View>
                  <Text style={{ fontFamily: fonts.medium, color: colors.black }}>
                    {order.customer_phone}
                    {order.customer_phone_alt ? ` · ${order.customer_phone_alt}` : ''}
                  </Text>
                  <Text style={{ fontFamily: fonts.medium, color: colors.black }}>
                    {order.raw_address}
                  </Text>
                  <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary }}>
                    {order.items
                      .map((item) => `${item.quantity} × ${item.product_name}`)
                      .join(' · ') || 'Open delivery to view products'}
                  </Text>
                  {order.instructions ? (
                    <Text style={{ fontFamily: fonts.medium, color: colors.black }}>
                      {order.instructions}
                    </Text>
                  ) : null}
                  <Text style={{ fontFamily: fonts.medium, color: colors.black }}>
                    Rider: {order.agent_name ?? 'Unassigned'} · Customer total:{' '}
                    {formatNaira(order.customer_price)}
                  </Text>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onPress={() => {
                      onClose();
                      router.push({
                        pathname: `${base}/deliveries/[id]`,
                        params: { id: order.id },
                      });
                    }}
                  >
                    Open delivery
                  </Button>
                </View>
              </Card>
            ))}
            {canManage && selectedOrders.length ? (
              <>
                <Text style={{ fontFamily: fonts.semibold, color: colors.black }}>
                  {selectedOrders.length} selected
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {details.data.match_kind !== 'single' ? (
                    <Button
                      size="sm"
                      disabled={busy || !hasOpenSelection}
                      onPress={() => {
                        setChooseRider(!chooseRider);
                        setAction(null);
                      }}
                    >
                      Assign selected
                    </Button>
                  ) : null}
                  {details.data.match_kind === 'alternate' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || selectedOrders.length < 2}
                      onPress={() => {
                        setAction('link');
                        setChooseRider(false);
                      }}
                    >
                      Confirm customer match
                    </Button>
                  ) : null}
                  {details.data.match_kind !== 'single' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        setAction('split');
                        setChooseRider(false);
                      }}
                    >
                      Different customers
                    </Button>
                  ) : null}
                  {selectedOrders.some((order) => order.match_mode !== 'auto') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onPress={() => {
                        setAction('reset');
                        setChooseRider(false);
                      }}
                    >
                      Use phone matching
                    </Button>
                  ) : null}
                </View>
              </>
            ) : null}
            {chooseRider ? (
              <View style={{ gap: 10 }}>
                <Input
                  label="Choose rider"
                  placeholder="Search riders"
                  value={riderSearch}
                  onChange={setRiderSearch}
                  editable={!busy}
                />
                {users.error ? <Banner tone="error">{users.error}</Banner> : null}
                {users.loading ? (
                  <ActivityIndicator />
                ) : (
                  agents.map((agent) => (
                    <Button
                      key={agent.id}
                      variant="secondary"
                      full
                      disabled={busy}
                      onPress={() => void assign(agent.id)}
                    >
                      {agent.display_name}
                    </Button>
                  ))
                )}
                {!users.loading && !agents.length ? (
                  <Text>No riders match your search.</Text>
                ) : null}
              </View>
            ) : null}
            {action ? (
              <View style={{ gap: 10 }}>
                <Input
                  label="Reason for correcting this customer match"
                  value={reason}
                  onChange={setReason}
                  multiline
                  editable={!busy}
                />
                <Button disabled={busy || !reason.trim()} onPress={() => void correct()}>
                  Save correction
                </Button>
              </View>
            ) : null}
            {busy ? <ActivityIndicator color={colors.black} /> : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}
