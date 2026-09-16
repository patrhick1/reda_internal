import { useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ActivityIndicator, Text, View } from 'react-native';
import { Banner, Button, Card, Input, Sheet } from '@/components/ui';
import { useCurrentUser } from '@/hooks/useAuth';
import { formatDateLagos } from '@/lib/date';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { fonts } from '@/lib/theme';
import { newClientUuid } from '@/lib/uuid';
import { getSameCustomerPayGroup, reviewSameCustomerManualPay } from '@/services/same-customer';

export function SameCustomerManualPaySheet({
  groupId,
  onClose,
  onReviewed,
}: {
  groupId: string;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const user = useCurrentUser();
  const query = useInfiniteQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'pay-group', groupId],
    queryFn: ({ pageParam }) => getSameCustomerPayGroup(groupId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page?.next_cursor ?? undefined,
    enabled: user.role === 'admin',
    staleTime: 0,
  });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const pages = query.data?.pages ?? [];
  const group = pages[0];
  const orders = pages.flatMap((page) => page?.orders ?? []);
  const consistent = !!group && pages.every((page) => page?.revision === group.revision);
  const complete = consistent && orders.length === group.total_count && !query.hasNextPage;
  async function confirm() {
    if (!group || !complete || !reason.trim() || busy || query.isFetching) return;
    const input = { groupId, revision: group.revision, reason: reason.trim() };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload) request.current = { payload, id: newClientUuid() };
    setBusy(true);
    setError(null);
    try {
      await reviewSameCustomerManualPay({ ...input, requestId: request.current.id });
      onReviewed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      title="Review group amounts"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <Button variant="secondary" full disabled={busy} onPress={onClose}>
          Close
        </Button>
      }
    >
      <View style={{ padding: 16, gap: 12 }}>
        <Banner tone="info">
          {group?.mode === 'final'
            ? 'Review the complete group, including each manual exception. Confirming applies these amounts to actual rider earnings in open periods.'
            : 'Review the complete group, including each manual exception. Confirming updates the proposed calculation; current payable amounts stay unchanged.'}
        </Banner>
        {query.isPending ? <ActivityIndicator /> : null}
        {query.error || error ? (
          <Banner tone="error">{error ?? errorMessage(query.error)}</Banner>
        ) : null}
        {group ? (
          <>
            <Text style={{ fontFamily: fonts.bold }}>
              {group.rider_name} · {formatDateLagos(group.business_date)}
            </Text>
            <Text>
              {orders.length} of {group.total_count} deliveries shown
            </Text>
            {!consistent ? (
              <Banner tone="warn">
                The group changed while loading. Refresh before reviewing.
              </Banner>
            ) : null}
            {orders.map((order) => (
              <Card key={order.delivery_id} style={{ gap: 6 }}>
                <Text style={{ fontFamily: fonts.semibold }}>
                  {order.customer_name} · {order.vendor_name}
                </Text>
                <Text>Order #{order.delivery_id.slice(0, 8)}</Text>
                <Text>
                  Normal fee: {order.normal_fee == null ? 'Not set' : formatNaira(order.normal_fee)}{' '}
                  · {order.multiplier === 1 ? 'Full' : 'Half'} fee tier
                </Text>
                <Text>
                  Current payable:{' '}
                  {order.current_payable == null
                    ? 'Pending review'
                    : formatNaira(order.current_payable)}
                </Text>
                <Text style={{ fontFamily: fonts.semibold }}>
                  Proposed:{' '}
                  {order.proposed_amount == null
                    ? 'Needs rate correction'
                    : formatNaira(order.proposed_amount)}
                </Text>
                {order.manual_amount != null ? (
                  <Text>
                    Manual exception: {formatNaira(order.manual_amount)} · {order.manual_reason}
                  </Text>
                ) : null}
                <Text>Accounting date: {formatDateLagos(order.accounting_date)}</Text>
              </Card>
            ))}
            {query.hasNextPage ? (
              <Button
                variant="secondary"
                disabled={query.isFetching}
                onPress={() => void query.fetchNextPage()}
              >
                Load more deliveries
              </Button>
            ) : null}
            <Text style={{ fontFamily: fonts.bold }}>
              Proposed group total:{' '}
              {group.proposed_total == null
                ? 'Needs rate correction'
                : formatNaira(group.proposed_total)}
            </Text>
            {group.state === 'manual_review' ? (
              <>
                <Input
                  label="Review reason"
                  value={reason}
                  onChange={(value) => {
                    if (!busy) setReason(value);
                  }}
                  multiline
                  maxLength={2000}
                />
                <Button
                  disabled={!complete || !reason.trim() || busy || query.isFetching}
                  onPress={() => void confirm()}
                >
                  {busy ? 'Saving…' : 'Confirm reviewed amounts'}
                </Button>
              </>
            ) : (
              <Banner tone="info">
                {group.state === 'ready'
                  ? 'This group has no pending manual review.'
                  : 'Correct the normal rates before reviewing manual exceptions.'}
              </Banner>
            )}
          </>
        ) : null}
        {!query.isPending && !group ? (
          <Banner tone="info">This pay group is no longer available.</Banner>
        ) : null}
        <Button
          variant="secondary"
          disabled={busy || query.isFetching}
          onPress={() => {
            setError(null);
            void query.refetch();
          }}
        >
          Refresh group
        </Button>
      </View>
    </Sheet>
  );
}
