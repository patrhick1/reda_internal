import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listBotInbound, type BotInboundRow, type InboundStatus } from '@/services/bot';
import { canResolveReview } from '@/lib/permissions';
import { AppBar, Banner, Card, Empty, Hint, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { reviewReason } from './reviewReason';
import { HINTS } from '@/hints/registry';

type Tab = 'needs_review' | 'shadow_only' | 'error' | 'all';

const TABS: { key: Tab; label: string; status: InboundStatus | 'all' }[] = [
  { key: 'needs_review', label: 'Needs Review', status: 'needs_review' },
  { key: 'shadow_only', label: 'Shadow', status: 'shadow_only' },
  { key: 'error', label: 'Errors', status: 'error' },
  { key: 'all', label: 'All', status: 'all' },
];

const INBOUND_PILL_TONE: Record<InboundStatus, { label: string; bg: string; fg: string }> = {
  queued: { label: 'queued', bg: colors.infoSoft, fg: colors.infoDark },
  parsed: { label: 'parsed', bg: colors.successSoft, fg: colors.successDark },
  shadow_only: { label: 'shadow', bg: colors.warningSoft, fg: colors.warningDark },
  needs_review: { label: 'needs review', bg: colors.redSoft, fg: colors.red },
  created_delivery: { label: 'delivery created', bg: colors.successSoft, fg: colors.successDark },
  duplicate: { label: 'duplicate', bg: colors.closedSoft, fg: colors.closed },
  error: { label: 'error', bg: colors.redSoft, fg: colors.red },
};

export function NeedsReviewScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const [tab, setTab] = useState<Tab>('needs_review');
  const status = TABS.find((t) => t.key === tab)!.status;
  const rowsQ = useAsync<BotInboundRow[]>(() => listBotInbound(status, 100), [status]);

  useFocusEffect(
    useCallback(() => {
      rowsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]),
  );

  const canFix = canResolveReview(user.role);
  const detailRouteBase: `/${string}` =
    user.role === 'dispatcher'
      ? '/(dispatcher)/review'
      : user.role === 'rep'
        ? '/(rep)/review'
        : '/(admin)/needs-review';
  const onRowPress = (row: BotInboundRow) => {
    // Only Needs Review rows are actionable: each has a real candidate
    // delivery hiding in its parse_result. Other tabs stay informational.
    if (tab !== 'needs_review' || !canFix) return null;
    return () => router.push(`${detailRouteBase}/${row.id}` as `/${string}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Needs review"
        subtitle={`${(rowsQ.data ?? []).length} ${tab.replace('_', ' ')}`}
        helpTopic="review"
      />

      <View
        style={{
          flexDirection: 'row',
          gap: 20,
          paddingHorizontal: 16,
          backgroundColor: colors.white,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={{
                paddingVertical: 14,
                borderBottomWidth: 2,
                borderBottomColor: active ? colors.red : 'transparent',
                marginBottom: -1,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 13,
                  color: active ? colors.black : colors.textSecondary,
                }}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={rowsQ.data ?? []}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <InboundCard row={item} onNavigate={onRowPress(item) ?? undefined} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshControl={
          <RefreshControl
            refreshing={rowsQ.loading && !!rowsQ.data}
            onRefresh={rowsQ.reload}
            tintColor={colors.black}
          />
        }
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        ListHeaderComponent={
          // One-time hint, only when the user is on the actionable tab and
          // there's actually something in the queue. Suppressed once dismissed.
          tab === 'needs_review' && canFix && (rowsQ.data ?? []).length > 0 ? (
            <View style={{ marginBottom: 12 }}>
              <Hint id={HINTS.REVIEW_TAP_TO_OPEN} title="Tip — Fix it in one tap">
                Tap any row to open the fix screen. The form is pre-filled with everything the bot
                already read; you just pick the missing piece (usually a location) and tap{' '}
                <Text style={{ fontFamily: fonts.bold }}>Create delivery</Text>.
              </Hint>
            </View>
          ) : null
        }
        ListEmptyComponent={
          rowsQ.error ? (
            <Empty icon="alert" title="Could not load" sub={rowsQ.error} />
          ) : rowsQ.loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="check"
              title="All clear"
              sub={
                tab === 'needs_review'
                  ? "Nothing in the queue. When the bot can't figure out an address or product, the row lands here for you to fix."
                  : 'Nothing in this view right now.'
              }
            />
          )
        }
      />
    </View>
  );
}

type ParseResult = {
  extracted?: {
    customer_name?: string;
    customer_phone?: string;
    raw_address?: string;
    quantity?: number;
    customer_price?: number;
  };
  product?: { product_name?: string; client_name?: string; score?: number } | null;
  address?: { matched_location_id?: string; confidence?: string } | null;
};

function InboundCard({ row, onNavigate }: { row: BotInboundRow; onNavigate?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const parse = (row.parse_result as ParseResult | null) ?? {};
  const extracted = parse.extracted ?? {};
  const product = parse.product;
  const address = parse.address;
  const time = new Date(row.received_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
  const pill = INBOUND_PILL_TONE[row.status];
  const reason =
    row.status === 'needs_review'
      ? reviewReason(row)
      : row.status === 'error'
        ? 'Parse failed'
        : null;

  return (
    <Card onPress={onNavigate ?? (() => setExpanded((e) => !e))}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <View
          style={{
            backgroundColor: pill.bg,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icon name="bot" size={12} color={pill.fg} />
          <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: pill.fg }}>
            {reason ?? pill.label}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: colors.textSecondary,
            marginLeft: 'auto',
          }}
        >
          {time}
        </Text>
        {onNavigate ? <Icon name="chevronRight" size={16} color={colors.textSecondary} /> : null}
      </View>
      {extracted.customer_name ? (
        <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
          {extracted.customer_name}
        </Text>
      ) : null}
      {product?.product_name || extracted.quantity || extracted.customer_price ? (
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 13,
            color: colors.textSecondary,
            marginTop: 2,
          }}
        >
          {product?.product_name ?? '—'}
          {extracted.quantity ? ` × ${extracted.quantity}` : ''}
          {extracted.customer_price ? ` · ${formatNaira(extracted.customer_price)}` : ''}
        </Text>
      ) : null}
      <View
        style={{ marginTop: 8, padding: 10, backgroundColor: colors.surfaceAlt, borderRadius: 10 }}
      >
        <Text
          style={{
            fontFamily: fonts.bold,
            fontSize: 11,
            color: colors.textSecondary,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
          }}
        >
          Raw address
        </Text>
        <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.black, marginTop: 4 }}>
          {extracted.raw_address ?? '—'}
        </Text>
        {expanded && row.raw_text ? (
          <View
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.regular,
                fontSize: 12,
                color: colors.textSecondary,
                fontStyle: 'italic',
                lineHeight: 18,
              }}
            >
              &ldquo;{row.raw_text}&rdquo;
            </Text>
          </View>
        ) : null}
      </View>
      {expanded ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          <DetailRow label="Phone" value={extracted.customer_phone ?? '—'} />
          <DetailRow
            label="Product"
            value={
              product
                ? `${product.product_name} (${product.client_name}${product.score ? `, score ${product.score.toFixed(2)}` : ''})`
                : 'no match'
            }
          />
          <DetailRow
            label="Location"
            value={address?.matched_location_id ? `${address.confidence} confidence` : 'no match'}
          />
          {row.delivery_id ? <DetailRow label="Delivery" value={row.delivery_id} /> : null}
          {row.error_text ? <DetailRow label="Error" value={row.error_text} /> : null}
        </View>
      ) : null}
      {row.error_text && !expanded ? (
        <View style={{ marginTop: 8 }}>
          <Banner tone="error" icon="alert">
            {row.error_text}
          </Banner>
        </View>
      ) : null}
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Text
        style={{ width: 70, fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary }}
      >
        {label}
      </Text>
      <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 12, color: colors.black }}>
        {value}
      </Text>
    </View>
  );
}
