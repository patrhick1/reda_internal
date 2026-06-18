import { useState, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { listProducts, type ProductWithClient } from '@/services/products';

type Section = { title: string; data: ProductWithClient[] };

export default function ProductsList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [query, setQuery] = useState('');
  const { data, loading, error, reload } = useAsync(
    () => listProducts({ includeInactive }),
    [includeInactive],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Search is a pure client-side filter — the full list is already loaded, so
  // no extra query/pagination. Empty query = unfiltered (today's behavior).
  const sections: Section[] = useMemo(
    () => groupByClient(filterProducts(data ?? [], query)),
    [data, query],
  );
  const searching = query.trim().length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setIncludeInactive((v) => !v)}>
          <Text style={styles.toggle}>{includeInactive ? 'Hide inactive' : 'Show inactive'}</Text>
        </TouchableOpacity>
        <Link href="/(admin)/catalog/products/new" asChild>
          <Button title="New product" onPress={() => undefined} style={styles.newBtn} />
        </Link>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search products or vendor"
          placeholderTextColor="#999"
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Button title="Retry" onPress={reload} variant="secondary" />
        </View>
      ) : loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          {searching ? (
            <>
              <Text style={styles.empty}>No products match “{query.trim()}”.</Text>
              <Text style={styles.emptySub}>Try a different name or vendor.</Text>
            </>
          ) : (
            <>
              <Text style={styles.empty}>No products yet.</Text>
              <Text style={styles.emptySub}>Tap “New product” to add one.</Text>
            </>
          )}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <ProductRow product={item} />}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
        />
      )}
    </View>
  );
}

function ProductRow({ product }: { product: ProductWithClient }) {
  return (
    <Link href={{ pathname: '/(admin)/catalog/products/[id]', params: { id: product.id } }} asChild>
      <TouchableOpacity style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={[styles.name, !product.is_active && styles.nameInactive]}>
            {product.product_name}
          </Text>
          {product.description ? <Text style={styles.meta}>{product.description}</Text> : null}
        </View>
        {!product.is_active ? <Text style={styles.badge}>inactive</Text> : null}
        <Text style={styles.chev}>›</Text>
      </TouchableOpacity>
    </Link>
  );
}

/** Case-insensitive match across product name, vendor (client) name, and
 *  description. Pure; runs over the already-loaded list. */
function filterProducts(products: ProductWithClient[], query: string): ProductWithClient[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter(
    (p) =>
      p.product_name.toLowerCase().includes(q) ||
      p.client_name.toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q),
  );
}

function groupByClient(products: ProductWithClient[]): Section[] {
  const map = new Map<string, ProductWithClient[]>();
  for (const p of products) {
    const arr = map.get(p.client_name) ?? [];
    arr.push(p);
    map.set(p.client_name, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, data]) => ({ title, data }));
}

// Avoid unused-import warning for FlatList (kept for future swap with SectionList for flat view)
void FlatList;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  toggle: { fontSize: 14, color: '#333', fontWeight: '500' },
  newBtn: { paddingHorizontal: 14, minHeight: 36 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 12 },
  search: {
    borderWidth: 1,
    borderColor: '#e2e2e2',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
    backgroundColor: '#fafafa',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  list: { paddingHorizontal: 16, paddingVertical: 12 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowLeft: { flex: 1 },
  name: { fontSize: 16, color: '#111', fontWeight: '500' },
  nameInactive: { color: '#888', textDecorationLine: 'line-through' },
  meta: { fontSize: 13, color: '#666', marginTop: 2 },
  badge: {
    fontSize: 11,
    color: '#a04000',
    backgroundColor: '#fde9d8',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
    overflow: 'hidden',
  },
  chev: { fontSize: 24, color: '#bbb' },
  sep: { height: 1, backgroundColor: '#f0f0f0' },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  empty: { fontSize: 16, color: '#333', marginBottom: 4 },
  emptySub: { fontSize: 13, color: '#888' },
});
