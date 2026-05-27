import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listCurrentStock,
  groupByClient,
  type StockMatrixRow,
  type ClientStockGroup,
} from '@/services/stock';
import { listClients, type Client } from '@/services/clients';
import { listUsers, type AppUser } from '@/services/users';
import { AppBar, Avatar, Button, Card, Empty, Icon, Tabs } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

type Section = {
  title: string;
  sub: string;
  data: StockMatrixRow[];
  isWarehouse: boolean;
  isEmpty?: boolean;
};

const LOW_THRESHOLD = 3;
type Tab = 'holder' | 'client';

export default function AdminStock() {
  const router = useRouter();
  const stockQ = useAsync(() => listCurrentStock(), []);
  const usersQ = useAsync(() => listUsers(), []);
  const clientsQ = useAsync<Client[]>(() => listClients(), []);

  useFocusEffect(
    useCallback(() => {
      stockQ.reload();
      // listUsers data is comparatively stable; refetch on focus too in case admin adds a warehouse user.
      usersQ.reload();
      clientsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const [tab, setTab] = useState<Tab>('holder');
  const rows = useMemo(() => stockQ.data ?? [], [stockQ.data]);
  const warehouseUsers = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.is_active && u.role === 'warehouse'),
    [usersQ.data],
  );

  const sections = useMemo(() => groupByUser(rows, warehouseUsers), [rows, warehouseUsers]);
  // Merge the full active-clients list with the stock-driven groups so every
  // active client appears in the By Client tab — even when Reda holds zero of
  // their products. Otherwise a client that's been newly added (or fully
  // depleted) silently disappears from the page.
  const clientGroups = useMemo<ClientStockGroup[]>(
    () => mergeClientsWithStockGroups(groupByClient(rows), clientsQ.data ?? []),
    [rows, clientsQ.data],
  );

  const loading = stockQ.loading || usersQ.loading || clientsQ.loading;
  const error = stockQ.error || usersQ.error || clientsQ.error;
  const reload = () => {
    stockQ.reload();
    usersQ.reload();
    clientsQ.reload();
  };

  const holderCount = sections.length;
  const clientCount = clientGroups.length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Stock"
        subtitle={
          tab === 'holder'
            ? `${holderCount} ${holderCount === 1 ? 'holder' : 'holders'}`
            : `${clientCount} ${clientCount === 1 ? 'client' : 'clients'}`
        }
        onBack={() => router.back()}
        helpTopic="stock"
      />

      {/* Primary action: Receive stock (most common). Two secondary actions below. */}
      <View
        style={{
          padding: 16,
          gap: 8,
          backgroundColor: colors.white,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Button
          variant="primary"
          full
          icon="arrowDown"
          onPress={() => router.push('/(admin)/stock/receive')}
        >
          Receive stock
        </Button>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button
              variant="secondary"
              full
              icon="arrowRight"
              onPress={() => router.push('/(admin)/stock/transfer')}
            >
              New transfer
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button
              variant="secondary"
              full
              icon="edit"
              onPress={() => router.push('/(admin)/stock/adjust')}
            >
              Adjustment
            </Button>
          </View>
        </View>
      </View>

      <Tabs<Tab>
        value={tab}
        tabs={[
          { id: 'holder', label: 'By holder' },
          { id: 'client', label: 'By client' },
        ]}
        onChange={setTab}
      />

      {error ? (
        <Empty icon="alert" title="Could not load" sub={error} />
      ) : loading && !stockQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : tab === 'holder' ? (
        sections.length === 0 ? (
          <Empty
            icon="warehouse"
            title="No stock anywhere"
            sub="Tap Receive stock above to record a vendor intake — that's the usual starting point. New transfer moves stock once it's in."
          />
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(r, i) =>
              r.user_id ? `${r.user_id}:${r.product_catalog_id}` : `empty:${i}`
            }
            renderItem={({ item, section }) =>
              section.isEmpty ? (
                <Card dense>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 13,
                      color: colors.textSecondary,
                      fontStyle: 'italic',
                    }}
                  >
                    No stock currently at this warehouse.
                  </Text>
                </Card>
              ) : (
                <Row row={item} />
              )
            }
            renderSectionHeader={({ section }) => (
              <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {section.isWarehouse ? (
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: colors.black,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="warehouse" size={16} color={colors.white} />
                    </View>
                  ) : (
                    <Avatar user={{ display_name: section.title }} size={32} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                      {section.title}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.medium,
                        fontSize: 12,
                        color: colors.textSecondary,
                      }}
                    >
                      {section.sub}
                    </Text>
                  </View>
                </View>
              </View>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
            refreshControl={
              <RefreshControl
                refreshing={loading && !!stockQ.data}
                onRefresh={reload}
                tintColor={colors.black}
              />
            }
          />
        )
      ) : clientGroups.length === 0 ? (
        <Empty
          icon="package"
          title="No clients yet"
          sub="Add a client in Catalog before recording stock."
        />
      ) : (
        <FlatList
          data={clientGroups}
          keyExtractor={(c) => c.client_id}
          renderItem={({ item }) => (
            <ClientCard
              group={item}
              onPress={() => router.push(`/(admin)/stock/client/${item.client_id}`)}
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={loading && !!stockQ.data}
              onRefresh={reload}
              tintColor={colors.black}
            />
          }
        />
      )}
    </View>
  );
}

function Row({ row }: { row: StockMatrixRow }) {
  const negative = row.quantity_on_hand < 0;
  const low = !negative && row.quantity_on_hand <= LOW_THRESHOLD;
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>
            {row.product_name}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {row.client_name}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: fonts.extrabold,
            fontSize: 18,
            letterSpacing: -0.4,
            color: negative ? colors.red : low ? colors.warningDark : colors.black,
          }}
        >
          {row.quantity_on_hand}
          {negative ? ' ⚠' : ''}
        </Text>
      </View>
    </Card>
  );
}

function ClientCard({ group, onPress }: { group: ClientStockGroup; onPress: () => void }) {
  const out = group.total_qty === 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
              {group.client_name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 2,
              }}
            >
              {out
                ? 'Nothing in stock right now'
                : `${group.products_count} ${group.products_count === 1 ? 'product' : 'products'} · ${group.warehouse_qty} warehouse · ${group.agents_qty} with agents`}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 20,
                letterSpacing: -0.5,
                color: out ? colors.red : colors.black,
              }}
            >
              {group.total_qty}
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
              total
            </Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </View>
      </Card>
    </Pressable>
  );
}

/** Returns one entry per active client, sorted by name. Clients with no stock
 *  rows in `groupByClient` get a zero-valued placeholder so they still appear
 *  on the By Client tab. */
function mergeClientsWithStockGroups(
  stockGroups: ClientStockGroup[],
  clients: Client[],
): ClientStockGroup[] {
  const byId = new Map(stockGroups.map((g) => [g.client_id, g]));
  for (const c of clients) {
    if (byId.has(c.id)) continue;
    byId.set(c.id, {
      client_id: c.id,
      client_name: c.name,
      products: [],
      total_qty: 0,
      warehouse_qty: 0,
      agents_qty: 0,
      products_count: 0,
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.client_name.localeCompare(b.client_name));
}

// Groups stock rows into per-user sections AND ensures every active warehouse
// user shows up at the top — even if they currently hold zero. An empty
// warehouse section gets a single placeholder row rendered with an evergreen
// note. This trains Uzo's mental model toward staging stock at the warehouse
// even when historical data has intakes going straight to agents.
function groupByUser(rows: StockMatrixRow[], warehouseUsers: AppUser[]): Section[] {
  const map = new Map<string, Section>();

  // Seed: empty section per active warehouse user. Filled in by the loop below
  // if they actually have rows. Placeholder uses an empty data array — handled
  // at render time as the "No stock currently at this warehouse" copy.
  for (const w of warehouseUsers) {
    map.set(w.id, {
      title: w.display_name,
      sub: `${w.role} · ${w.email}`,
      data: [],
      isWarehouse: true,
    });
  }

  for (const r of rows) {
    const key = r.user_id;
    const existing = map.get(key);
    if (existing) {
      existing.data.push(r);
    } else {
      map.set(key, {
        title: r.user_display_name,
        sub: `${r.user_role} · ${r.user_email}`,
        data: [r],
        isWarehouse: r.user_role === 'warehouse',
      });
    }
  }

  // Flag empty warehouse sections so the renderer shows the placeholder row.
  return Array.from(map.values())
    .map((s) =>
      s.isWarehouse && s.data.length === 0 ? { ...s, isEmpty: true, data: [PLACEHOLDER_ROW] } : s,
    )
    .sort((a, b) => {
      if (a.isWarehouse && !b.isWarehouse) return -1;
      if (b.isWarehouse && !a.isWarehouse) return 1;
      return a.title.localeCompare(b.title);
    });
}

// Sentinel used to drive the "No stock at warehouse" empty-state row.
// Identifiable because isEmpty=true on the section. Never rendered as a Row.
const PLACEHOLDER_ROW: StockMatrixRow = {
  user_id: '',
  user_email: '',
  user_display_name: '',
  user_role: 'warehouse',
  product_catalog_id: '',
  product_name: '',
  client_id: '',
  client_name: '',
  quantity_on_hand: 0,
};
