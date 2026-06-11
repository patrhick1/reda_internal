// Shared per-holder stock-movement history screen. Rendered from three
// route wrappers — warehouse, admin and agent — each passing `basePath`
// so the "tap a delivery row" branch can deep-link into the right route
// group without this screen knowing about routing.
//
// Rows are grouped into Today / Yesterday / date sections. Two server-side
// filters narrow the stream — by event type and by performer (the "who did
// what" / staff filter) — pushed into the RPC because the list is
// infinite-history and a client-side filter would only narrow the loaded page.
//
// Pagination is keyset-cursor on (event_at, event_id). Refocusing the screen —
// or changing a filter (loadFirstPage's identity changes, so the focus effect
// re-runs) — resets to page 1. The "Load older" button only renders while the
// last page returned `LIMIT` rows; once a partial page comes back we know we
// hit end-of-history and switch to a caption.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SectionList, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  listMovementActors,
  listStockMovements,
  nextCursor,
  type MovementActor,
  type MovementCursor,
  type MovementEventKind,
  type StockMovement,
} from '@/services/stock-movements';
import { getUser, type AppUser } from '@/services/users';
import { lagosDayKey, lagosDayLabel, relativeTime } from '@/lib/date';
import { AppBar, Button, Card, Empty, FilterChips, Icon, SectionHeader } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { type IconName } from '@/components/ui';

const PAGE_SIZE = 50;

export type MovementsBasePath = '/(admin)' | '/(dispatcher)' | '/(warehouse)' | '/(agent)';

// Friendly type chips → the underlying event kinds. `null` kinds = no filter.
type KindCategory = {
  id: string;
  label: string;
  kinds: MovementEventKind[] | null;
};

const KIND_CATEGORIES: KindCategory[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'received', label: 'Received', kinds: ['bulk_intake'] },
  { id: 'issued', label: 'Issued', kinds: ['warehouse_issue'] },
  { id: 'returns', label: 'Returns', kinds: ['warehouse_return'] },
  { id: 'transfers', label: 'Transfers', kinds: ['transfer'] },
  { id: 'delivered', label: 'Delivered', kinds: ['delivered'] },
  {
    id: 'adjustments',
    label: 'Adjustments',
    kinds: ['correction', 'loss', 'theft', 'damaged', 'found'],
  },
];

const ALL_ACTORS = '__all__';

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

  // Filters. `kindCat` is a category id from KIND_CATEGORIES; `actorId` is a
  // user id or null (everyone). Both feed the RPC via the filters arg.
  const [kindCat, setKindCat] = useState('all');
  const [actorId, setActorId] = useState<string | null>(null);
  const [actors, setActors] = useState<MovementActor[]>([]);

  const filtersActive = kindCat !== 'all' || actorId !== null;

  // Monotonic request id. Tapping filter chips quickly (or a "Load older" still
  // in flight when a filter changes) fires overlapping fetches; only the latest
  // one may touch state, so a slow stale response can't clobber a newer result.
  const reqRef = useRef(0);

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

  // Load the complete actor set for the staff-filter chips. Reset any active
  // actor filter when the holder changes so it never points at a stranger.
  useEffect(() => {
    let cancelled = false;
    setActorId(null);
    setActors([]);
    listMovementActors(holderId)
      .then((a) => {
        if (!cancelled) setActors(a);
      })
      .catch(() => {
        // Staff filter is an enhancement — if it fails to load we just hide
        // the chip row; the history itself still works.
      });
    return () => {
      cancelled = true;
    };
  }, [holderId]);

  const kindsFor = useCallback(
    (cat: string) => KIND_CATEGORIES.find((c) => c.id === cat)?.kinds ?? null,
    [],
  );

  const loadFirstPage = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listStockMovements(holderId, null, PAGE_SIZE, {
        actorId,
        kinds: kindsFor(kindCat),
      });
      if (reqRef.current !== req) return; // superseded by a newer load
      setRows(page);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [holderId, actorId, kindCat, kindsFor]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loading || endOfHistory) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listStockMovements(holderId, cursor, PAGE_SIZE, {
        actorId,
        kinds: kindsFor(kindCat),
      });
      if (reqRef.current !== req) return; // a filter change superseded this page
      setRows((prev) => [...prev, ...page]);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [holderId, cursor, loading, endOfHistory, actorId, kindCat, kindsFor]);

  useFocusEffect(
    useCallback(() => {
      // Refocus — or a filter change (loadFirstPage's identity changes) —
      // resets to page 1. Otherwise a user who paged deep and then backed out
      // would see the deep-paged state on re-entry.
      loadFirstPage();
    }, [loadFirstPage]),
  );

  const subtitle = useMemo(() => {
    if (!holder) return undefined;
    return `${holder.display_name} · ${roleLabel(holder.role)}`;
  }, [holder]);

  // Group the (already newest-first, day-contiguous) rows into day sections.
  const sections = useMemo(() => {
    const groups: { key: string; title: string; data: StockMovement[] }[] = [];
    let current: (typeof groups)[number] | null = null;
    for (const r of rows) {
      const key = lagosDayKey(r.event_at);
      if (!current || current.key !== key) {
        current = { key, title: lagosDayLabel(r.event_at), data: [] };
        groups.push(current);
      }
      current.data.push(r);
    }
    return groups;
  }, [rows]);

  const actorChips = useMemo(
    () => [
      { id: ALL_ACTORS, label: 'Everyone' },
      ...actors.map((a) => ({ id: a.actor_id, label: a.actor_name })),
    ],
    [actors],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Stock history" subtitle={subtitle} onBack={() => router.back()} />

      {/* Non-flex header so the chip ScrollViews keep their intrinsic height;
          the SectionList below is pinned with flex:1 to take the rest. Without
          that, the list's huge intrinsic height starves the chips to ~0px. */}
      <View>
        <FilterChips
          options={KIND_CATEGORIES.map((c) => ({ id: c.id, label: c.label }))}
          value={kindCat}
          onChange={setKindCat}
        />
        {/* Staff filter is for whoever oversees a holder's stock (ops / warehouse).
            On an agent's own history (the only thing the agent route shows) it's
            just noise — they're filtering "who did what" on their own shelf. */}
        {basePath !== '/(agent)' && actors.length > 1 ? (
          <FilterChips
            options={actorChips}
            value={actorId ?? ALL_ACTORS}
            onChange={(v) => setActorId(v === ALL_ACTORS ? null : v)}
          />
        ) : null}
      </View>

      <SectionList
        style={{ flex: 1 }}
        sections={sections}
        keyExtractor={(r) => `${r.source}:${r.event_id}`}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: 32, flexGrow: 1 }}
        renderSectionHeader={({ section }) => <SectionHeader>{section.title}</SectionHeader>}
        renderItem={({ item }) => (
          <MovementRow
            row={item}
            holderId={holderId}
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
          ) : loading ? null : filtersActive ? (
            <Empty
              icon="filter"
              title="No matching movements"
              sub="Try a different type or staff member."
            />
          ) : (
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

function MovementRow({
  row,
  holderId,
  onPress,
}: {
  row: StockMovement;
  holderId: string;
  onPress: (() => void) | undefined;
}) {
  const positive = row.quantity_delta > 0;
  const negative = row.quantity_delta < 0;
  const accent = positive ? colors.success : negative ? colors.red : colors.closed;
  const tint = positive ? colors.successSoft : negative ? colors.redSoft : colors.surface;
  const icon = iconFor(row.event_kind);
  const sub = subtitleFor(row, holderId);
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
            {relativeTime(row.event_at)}
          </Text>
        </View>
        {onPress ? <Icon name="chevronRight" size={18} color={colors.textTertiary} /> : null}
      </View>
    </Card>
  );
}

function iconFor(kind: MovementEventKind): IconName {
  switch (kind) {
    case 'bulk_intake':
      return 'arrowDown';
    case 'warehouse_issue':
      return 'arrowRight';
    case 'transfer':
      // 'share' (a sending/branching arrow) reads as a hand-off between two
      // holders; 'arrowRight' is reserved for a warehouse issue.
      return 'share';
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

/** The performer suffix for the paired-movement kinds (issue / return /
 *  transfer) — "· by Martha". Suppressed when the actor is unknown or is the
 *  holder being viewed (avoids "by yourself" on an agent's own history). */
function actorSuffix(row: StockMovement, holderId: string): string {
  if (!row.actor_name || row.actor_id === holderId) return '';
  return ` · by ${row.actor_name}`;
}

function subtitleFor(row: StockMovement, holderId: string): string {
  const counterpartyLabel =
    row.counterparty_holder_id != null ? (row.counterparty_holder_name ?? 'Unknown party') : null;
  switch (row.event_kind) {
    case 'bulk_intake':
      return row.actor_name ? `Received · by ${row.actor_name}` : 'Received';
    case 'warehouse_issue':
      // From a warehouse holder's perspective the row is -ve (issued out);
      // from an agent's it's +ve (received in). Same row, different sign.
      if (row.quantity_delta < 0) {
        return (
          (counterpartyLabel ? `Issued to ${counterpartyLabel}` : 'Issued out') +
          actorSuffix(row, holderId)
        );
      }
      return (
        (counterpartyLabel ? `Received from ${counterpartyLabel}` : 'Received') +
        actorSuffix(row, holderId)
      );
    case 'warehouse_return':
      if (row.quantity_delta < 0) {
        return (
          (counterpartyLabel ? `Returned to ${counterpartyLabel}` : 'Returned') +
          actorSuffix(row, holderId)
        );
      }
      return (
        (counterpartyLabel ? `Returned from ${counterpartyLabel}` : 'Returned in') +
        actorSuffix(row, holderId)
      );
    case 'transfer':
      if (row.quantity_delta < 0) {
        return (
          (counterpartyLabel ? `Transferred to ${counterpartyLabel}` : 'Transferred out') +
          actorSuffix(row, holderId)
        );
      }
      return (
        (counterpartyLabel ? `Transferred from ${counterpartyLabel}` : 'Transferred in') +
        actorSuffix(row, holderId)
      );
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
