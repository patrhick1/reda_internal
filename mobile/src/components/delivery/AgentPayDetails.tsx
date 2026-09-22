import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { Banner, Button } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { listAgentPayDetails, PAY_ISSUE_TEXT } from '@/services/fee-adjustments';
import { useCurrentUser } from '@/hooks/useAuth';

export function AgentPayDetails({
  agentId,
  from,
  to,
}: {
  agentId: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const user = useCurrentUser();
  const query = useInfiniteQuery({
    queryKey: ['deliveries', 'agent-pay-details', user.userId, agentId, from, to],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listAgentPayDetails(agentId, from, to, pageParam),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 0,
  });
  if (query.isPending) return <ActivityIndicator />;
  if (query.error)
    return (
      <View>
        <Banner tone="error">{errorMessage(query.error)}</Banner>
        <Button variant="secondary" onPress={() => void query.refetch()}>
          Retry fee details
        </Button>
      </View>
    );
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      {query.data?.pages
        .flatMap((page) => page.orders)
        .map((order) => (
          <View key={order.delivery_id} style={{ gap: 4 }}>
            <Text>
              {order.customer_name} · #{order.delivery_id.slice(0, 8)}
            </Text>
            {order.manual_amount != null ? (
              <Text>
                {formatNaira(order.manual_amount)} —{' '}
                {order.manual_amount === 0 ? 'manually waived' : 'manually set'}
                {order.manual_actor ? ` by ${order.manual_actor}` : ''}
                {order.manual_reason ? ` · ${order.manual_reason}` : ''}
              </Text>
            ) : null}
            {order.final_state === 'pending' ? (
              <Text>
                {PAY_ISSUE_TEXT[order.final_review_reason ?? ''] ??
                  'Open the order to review its payment details.'}
              </Text>
            ) : null}
            <Button
              variant="secondary"
              onPress={() => router.push(`/(admin)/deliveries/${order.delivery_id}`)}
            >
              Open order
            </Button>
          </View>
        ))}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        >
          More fee details
        </Button>
      ) : null}
    </View>
  );
}
