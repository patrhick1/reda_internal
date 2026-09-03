import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useCurrentUser } from '@/hooks/useAuth';
import { listCustomerBlacklist, type BlacklistEntry } from '@/services/blacklist';
import { normalizePhoneForGrouping } from '@/services/deliveries';
import { canManageBlacklist } from '@/lib/permissions';
import { Banner, Button, Card, Empty, Icon, Input } from '@/components/ui';
import { BlacklistNumberSheet } from '@/components/sheets/BlacklistNumberSheet';
import { RemoveBlacklistSheet } from '@/components/sheets/RemoveBlacklistSheet';
import { formatDateTime, formatNgPhone } from '@/lib/format';
import { colors, fonts } from '@/lib/theme';

/** Catalog › Blacklist. Customer numbers whose orders are refused. The list is
 *  small (tens of rows), so search filters client-side over the loaded set —
 *  by digits in any format, or by words in the reason. */
export function BlacklistList() {
  const router = useRouter();
  const user = useCurrentUser();
  const mayManage = canManageBlacklist(user.role);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<BlacklistEntry | null>(null);

  const rowsQ = useAsync(() => listCustomerBlacklist({ includeRemoved }), [includeRemoved]);
  useReloadOnFocus(rowsQ.reload);

  const filtered = useMemo(() => {
    const rows = rowsQ.data ?? [];
    const text = query.trim().toLowerCase();
    if (!text) return rows;
    const digits = normalizePhoneForGrouping(query);
    return rows.filter(
      (r) =>
        (digits ? r.phone_normalized.includes(digits) : false) ||
        r.reason.toLowerCase().includes(text) ||
        r.phone_display.toLowerCase().includes(text),
    );
  }, [rowsQ.data, query]);

  const active = (rowsQ.data ?? []).filter((r) => !r.removed_at).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black }}>
              {rowsQ.data ? `${active} ${active === 1 ? 'number' : 'numbers'} listed` : ' '}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 2,
              }}
            >
              Orders from a listed number are refused, from the bot and from the app.
            </Text>
          </View>
          {mayManage ? (
            <Button variant="emphasis" size="sm" icon="plus" onPress={() => setAddOpen(true)}>
              Add number
            </Button>
          ) : null}
        </View>
        <Input
          icon="search"
          value={query}
          onChange={setQuery}
          placeholder="Search digits or reason"
          autoCapitalize="none"
          autoCorrect={false}
          rightAdornment={
            query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Icon name="x" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            ) : null
          }
        />
        <Pressable onPress={() => setIncludeRemoved((v) => !v)} hitSlop={8}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary }}>
            {includeRemoved ? 'Hide removed numbers' : 'Show removed numbers'}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <EntryCard
            entry={item}
            canRemove={mayManage && !item.removed_at}
            onRemove={() => setRemoving(item)}
            onOpenDelivery={
              item.source_delivery_id
                ? () =>
                    router.push(`/(admin)/deliveries/${item.source_delivery_id}` as `/${string}`)
                : undefined
            }
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={rowsQ.loading && !!rowsQ.data}
            onRefresh={rowsQ.reload}
            tintColor={colors.black}
          />
        }
        ListEmptyComponent={
          rowsQ.error ? (
            <Empty icon="alert" title="Could not load the blacklist" sub={rowsQ.error} />
          ) : rowsQ.loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : query.trim() ? (
            <Empty
              icon="search"
              title="No matches"
              sub="No listed number or reason contains that."
            />
          ) : (
            <Empty
              icon="phoneOff"
              title="Nothing blacklisted yet"
              sub="Add a number here, or tap the blacklist icon on a delivery whose customer keeps wasting trips."
            />
          )
        }
      />

      <BlacklistNumberSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          rowsQ.reload();
        }}
      />
      <RemoveBlacklistSheet
        open={removing !== null}
        entry={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          rowsQ.reload();
        }}
      />
    </View>
  );
}

function EntryCard({
  entry,
  canRemove,
  onRemove,
  onOpenDelivery,
}: {
  entry: BlacklistEntry;
  canRemove: boolean;
  onRemove: () => void;
  onOpenDelivery?: () => void;
}) {
  const removed = !!entry.removed_at;
  return (
    <Card style={removed ? { opacity: 0.7 } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontFamily: fonts.monoMedium,
              fontSize: 16,
              color: colors.black,
              textDecorationLine: removed ? 'line-through' : 'none',
            }}
          >
            {formatNgPhone(entry.phone_display)}
          </Text>
          <Text
            style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.black, marginTop: 4 }}
          >
            {entry.reason}
          </Text>
        </View>
        {entry.blocked_count > 0 ? (
          <View
            style={{
              backgroundColor: colors.redSoft,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 999,
            }}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: colors.red }}>
              blocked {entry.blocked_count}×
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 12,
          color: colors.textSecondary,
          marginTop: 8,
        }}
      >
        Added by {entry.added_by_name ?? 'unknown'} · {formatDateTime(entry.added_at)}
        {entry.last_blocked_at ? ` · last blocked ${formatDateTime(entry.last_blocked_at)}` : ''}
      </Text>
      {removed ? (
        <View style={{ marginTop: 8 }}>
          <Banner tone="info" icon="check">
            {`Removed by ${entry.removed_by_name ?? 'unknown'} · ${formatDateTime(entry.removed_at)}${entry.removal_note ? ` — ${entry.removal_note}` : ''}`}
          </Banner>
        </View>
      ) : null}
      {onOpenDelivery || canRemove ? (
        <View style={{ flexDirection: 'row', gap: 18, marginTop: 10 }}>
          {onOpenDelivery ? (
            <Pressable onPress={onOpenDelivery} hitSlop={8}>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.info }}>
                View the delivery
              </Text>
            </Pressable>
          ) : null}
          {canRemove ? (
            <Pressable onPress={onRemove} hitSlop={8}>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.red }}>
                Remove
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
