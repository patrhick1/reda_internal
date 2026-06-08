// Shared per-holder stock-movement history screen. Rendered from three
// route wrappers — warehouse, admin and agent — each passing `basePath`
// so the "tap a delivery row" branch can deep-link into the right route
// group without this screen knowing about routing.
//
// Pagination is keyset-cursor on (event_at, event_id). Refocusing the
// screen resets to page 1 so users don't see stale paged state when they
// come back. The "Load older" button only renders while the last page
// returned `LIMIT` rows; once a partial page comes back we know we hit
// end-of-history and switch to a caption.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  listStockMovements,
  nextCursor,
  type MovementCursor,
  type MovementEventKind,
  type StockMovement,
} from '@/services/stock-movements';
import { getUser, type AppUser } from '@/services/users';
import { AppBar, Button, Card, Empty, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { type IconName } from '@/components/ui';

const PAGE_SIZE = 50;

export type MovementsBasePath = '/(admin)' | '/(dispatcher)' | '/(warehouse)' | '/(agent)';

export function Movements({
  holderId,
  basePath,
}: {
  holderId: string;
  basePath: MovementsBasePath;
}) {
  const router = useRouter();
  const [holder, setHolder] = useState<AppUser | null>(null);
  const [rows, setRows] = useState<StockMovement[]>([]);
  const [cursor, setCursor] = useState<MovementCursor>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endOfHistory, setEndOfHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getUser(holderId)
      .then((u) => {
        if (!cancelled) setHolder(u);
      })
      .catch(() => {
        // Holder name is non-critical — the page still renders with the
        // raw id. Don't block the screen on this lookup.
      });
    return () => {
      cancelled = true;
    };
  }, [holderId]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listStockMovements(holderId, null, PAGE_SIZE);
      setRows(page);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [holderId]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loading || endOfHistory) return;
    setLoading(true);
    setError(null);
    try {
      const page = await listStockMovements(holderId, cursor, PAGE_SIZE);
      setRows((prev) => [...prev, ...page]);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [holderId, cursor, loading, endOfHistory]);

  useFocusEffect(
    useCallback(() => {
      // Refocus resets to page 1 — otherwise a user who paged deep and then
      // backed out would see the deep-paged state on re-entry.
      loadFirstPage();
    }, [loadFirstPage]),
  );

  const subtitle = useMemo(() => {
    if (!holder) return undefined;
    return `${holder.display_name} · ${roleLabel(holder.role)}`;
  }, [holder]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Stock history" subtitle={subtitle} onBack={() => router.back()} />
      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.source}:${r.event_id}`}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        renderItem={({ item }) => (
          <MovementRow
            row={item}
            onPress={
              item.source === 'delivery' && item.delivery_id
                ? () =>
                    router.push(
                      `${basePath}/deliveries/${item.delivery_id}` as `${MovementsBasePath}/deliveries/${string}`,
                    )
                : undefined
            }
          />
        )}
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load history" sub={error} />
          ) : loading ? null : (
            <Empty
              icon="package"
              title="No movements yet"
              sub="Receives, transfers, and delivered orders will show up here."
            />
          )
        }
        ListFooterComponent={
          rows.length === 0 ? null : endOfHistory ? (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11,
                color: colors.textTertiary,
                textAlign: 'center',
                marginTop: 18,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}
            >
              End of history
            </Text>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Button variant="secondary" full onPress={loadOlder} disabled={loading}>
                {loading ? 'Loading…' : 'Load older'}
              </Button>
            </View>
          )
        }
      />
    </View>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'dispatcher':
      return 'Dispatcher';
    case 'rep':
      return 'Rep';
    case 'agent':
      return 'Agent';
    case 'warehouse':
      return 'Warehouse';
    default:
      return role;
  }
}

function MovementRow({ row, onPress }: { row: StockMovement; onPress: (() => void) | undefined }) {
  const positive = row.quantity_delta > 0;
  const negative = row.quantity_delta < 0;
  const accent = positive ? colors.success : negative ? colors.red : colors.closed;
  const tint = positive ? colors.successSoft : negative ? colors.redSoft : colors.surface;
  const icon = iconFor(row.event_kind);
  const sub = subtitleFor(row);
  const partial =
    row.source === 'delivery' &&
    row.quantity_ordered != null &&
    Math.abs(row.quantity_delta) !== row.quantity_ordered;

  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              backgroundColor: tint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={20} color={accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
              numberOfLines={1}
            >
              {row.product_name}
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
              {sub}
            </Text>
            {row.notes ? (
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 11,
                  color: colors.textTertiary,
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {row.notes}
              </Text>
            ) : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 20,
                letterSpacing: -0.4,
                color: accent,
              }}
            >
              {positive ? '+' : ''}
              {row.quantity_delta}
            </Text>
            {partial ? (
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 10,
                  color: colors.textTertiary,
                  marginTop: 1,
                }}
              >
                {Math.abs(row.quantity_delta)} of {row.quantity_ordered}
              </Text>
            ) : null}
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 10,
                color: colors.textTertiary,
                marginTop: 1,
              }}
            >
              {shortWhen(row.event_at)}
            </Text>
          </View>
        </View>
    </Card>
  );
}

function iconFor(kind: MovementEventKind): IconName {
  switch (kind) {
    case 'bulk_intake':
      return 'arrowDown';
    case 'warehouse_issue':
    case 'transfer':
      return 'arrowRight';
    case 'warehouse_return':
      return 'arrowDown';
    case 'delivered':
      return 'truck';
    case 'correction':
    case 'found':
      return 'edit';
    case 'loss':
    case 'theft':
    case 'damaged':
      return 'alert';
    default:
      return 'package';
  }
}

function subtitleFor(row: StockMovement): string {
  const counterpartyLabel =
    row.counterparty_holder_id != null
      ? row.counterparty_holder_name ?? 'Unknown party'
      : null;
  switch (row.event_kind) {
    case 'bulk_intake':
      return row.actor_name ? `Received · by ${row.actor_name}` : 'Received';
    case 'warehouse_issue':
      // From a warehouse holder's perspective the row is -ve (issued out);
      // from an agent's it's +ve (received in). Same row, different sign.
      if (row.quantity_delta < 0) {
        return counterpartyLabel ? `Issued to ${counterpartyLabel}` : 'Issued out';
      }
      return counterpartyLabel ? `Received from ${counterpartyLabel}` : 'Received';
    case 'warehouse_return':
      if (row.quantity_delta < 0) {
        return counterpartyLabel ? `Returned to ${counterpartyLabel}` : 'Returned';
      }
      return counterpartyLabel ? `Returned from ${counterpartyLabel}` : 'Returned in';
    case 'transfer':
      if (row.quantity_delta < 0) {
        return counterpartyLabel ? `Transferred to ${counterpartyLabel}` : 'Transferred out';
      }
      return counterpartyLabel ? `Transferred from ${counterpartyLabel}` : 'Transferred in';
    case 'correction':
      return row.actor_name ? `Correction · by ${row.actor_name}` : 'Correction';
    case 'loss':
      return row.actor_name ? `Loss · by ${row.actor_name}` : 'Loss';
    case 'theft':
      return row.actor_name ? `Theft · by ${row.actor_name}` : 'Theft';
    case 'damaged':
      return row.actor_name ? `Damaged · by ${row.actor_name}` : 'Damaged';
    case 'found':
      return row.actor_name ? `Found · by ${row.actor_name}` : 'Found';
    case 'delivered':
      return row.customer_name ? `Delivered to ${row.customer_name}` : 'Delivered';
    default:
      return row.event_kind;
  }
}

function shortWhen(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const ms = now - t;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  // Fall back to a short calendar date for older events
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
