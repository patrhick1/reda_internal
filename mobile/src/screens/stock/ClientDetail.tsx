// Shared per-client stock detail screen — admin and dispatcher both render
// this via thin route wrappers. Read-only by design; the only action is the
// "Share with client" button which goes through the OS share sheet.
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Share, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listCurrentStock,
  groupByClient,
  type ClientProductTotal,
  type ClientStockGroup,
} from '@/services/stock';
import { listActiveProductsByClient, type Product } from '@/services/products';
import { AppBar, Button, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatDateLagos, todayLagos } from '@/lib/date';

export function ClientStockDetail() {
  const router = useRouter();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const stockQ = useAsync(() => listCurrentStock(), []);
  const productsQ = useAsync<Product[]>(
    () => (id ? listActiveProductsByClient(id) : Promise.resolve([])),
    [id],
  );
  useFocusEffect(
    useCallback(() => {
      stockQ.reload();
      productsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const group = useMemo<ClientStockGroup | null>(() => {
    const all = groupByClient(stockQ.data ?? []);
    return all.find((g) => g.client_id === id) ?? null;
  }, [stockQ.data, id]);

  const clientName = group?.client_name ?? name ?? 'Client';

  const products = useMemo<ClientProductTotal[]>(() => {
    const byProductId = new Map<string, ClientProductTotal>();
    for (const p of group?.products ?? []) {
      byProductId.set(p.product_catalog_id, p);
    }
    for (const p of productsQ.data ?? []) {
      if (!byProductId.has(p.id)) {
        byProductId.set(p.id, {
          product_catalog_id: p.id,
          product_name: p.product_name,
          total_qty: 0,
          warehouse_qty: 0,
          agents_qty: 0,
        });
      }
    }
    return Array.from(byProductId.values()).sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );
  }, [group, productsQ.data]);

  const outOfStockCount = useMemo(
    () => products.filter((p) => p.total_qty === 0).length,
    [products],
  );

  const onShare = useCallback(async () => {
    if (products.length === 0) return;
    const dateLabel = formatDateLagos(todayLagos());
    const header = [`Reda Logistics — ${clientName}`, `Stock snapshot — ${dateLabel}`].join('\n');

    const lines = products
      .map((p) =>
        p.total_qty === 0
          ? `• ${p.product_name}: OUT OF STOCK`
          : `• ${p.product_name}: ${p.total_qty} total (${p.warehouse_qty} warehouse, ${p.agents_qty} with agents)`,
      )
      .join('\n');

    const totalQty = group?.total_qty ?? 0;
    const footer = [
      ``,
      `Total: ${totalQty} units across ${products.length} ${products.length === 1 ? 'product' : 'products'}.`,
      ``,
      `Sent from Reda Logistics`,
    ].join('\n');

    const message = `${header}\n\n${lines}\n${footer}`;
    try {
      await Share.share({ message });
    } catch {
      /* user cancelled */
    }
  }, [clientName, group, products]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title={clientName} subtitle="Stock" onBack={() => router.back()} />

      <FlatList
        data={products}
        keyExtractor={(p) => p.product_catalog_id}
        contentContainerStyle={{ padding: 16, paddingBottom: 100, gap: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={stockQ.loading && !!stockQ.data}
            onRefresh={stockQ.reload}
            tintColor={colors.black}
          />
        }
        ListHeaderComponent={
          products.length > 0 ? (
            <Card style={{ marginBottom: 8 }}>
              <Text style={kicker}>Reda holds</Text>
              <Text
                style={{
                  fontFamily: fonts.extrabold,
                  fontSize: 32,
                  letterSpacing: -1,
                  marginTop: 4,
                  color: colors.black,
                }}
              >
                {group?.total_qty ?? 0} units
              </Text>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textSecondary,
                  marginTop: 4,
                }}
              >
                {products.length} {products.length === 1 ? 'product' : 'products'}
                {outOfStockCount > 0 ? ` · ${outOfStockCount} out of stock` : ''}
              </Text>

              <View style={{ marginTop: 14, gap: 6 }}>
                <SmallRow label="At warehouse" value={String(group?.warehouse_qty ?? 0)} />
                <SmallRow label="With agents" value={String(group?.agents_qty ?? 0)} />
              </View>
            </Card>
          ) : null
        }
        renderItem={({ item }) => <ProductRow product={item} />}
        ListEmptyComponent={
          stockQ.error || productsQ.error ? (
            <Empty
              icon="alert"
              title="Could not load"
              sub={stockQ.error ?? productsQ.error ?? ''}
            />
          ) : (stockQ.loading && !stockQ.data) || (productsQ.loading && !productsQ.data) ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="warehouse"
              title="No products"
              sub={`${clientName} has no active products in the catalog.`}
            />
          )
        }
      />

      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.white,
        }}
      >
        <Button
          variant="emphasis"
          full
          icon="share"
          onPress={onShare}
          disabled={products.length === 0}
        >
          Share with client
        </Button>
      </View>
    </View>
  );
}

function ProductRow({ product }: { product: ClientStockGroup['products'][number] }) {
  const out = product.total_qty === 0;
  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
            {product.product_name}
          </Text>
          {out ? (
            <View
              style={{
                alignSelf: 'flex-start',
                marginTop: 6,
                paddingHorizontal: 8,
                paddingVertical: 2,
                backgroundColor: colors.redSoft,
                borderRadius: 999,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 11,
                  color: colors.red,
                  letterSpacing: 0.3,
                }}
              >
                Out of stock
              </Text>
            </View>
          ) : (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 4,
              }}
            >
              Warehouse: {product.warehouse_qty} · With agents: {product.agents_qty}
            </Text>
          )}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 22,
              color: out ? colors.red : colors.black,
              letterSpacing: -0.4,
            }}
          >
            {product.total_qty}
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
      </View>
    </Card>
  );
}

function SmallRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>{value}</Text>
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
