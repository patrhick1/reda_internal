import { useState, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { Button } from '@/components/Button';
import { Icon, Input } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { listLocations, type Location } from '@/services/locations';

export default function LocationsList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [query, setQuery] = useState('');
  const { data, loading, error, reload } = useAsync(
    () => listLocations({ includeInactive }),
    [includeInactive],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Search matches the location name OR any of its aliases — so "have I added
  // this alias before?" is answerable without opening every location. Pure
  // client-side filter over the already-loaded set (≈56 rows); no round trip.
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = data ?? [];
    if (!needle) return rows;
    return rows.filter(
      (l) =>
        l.name.toLowerCase().includes(needle) ||
        (l.aliases ?? []).some((a) => a.toLowerCase().includes(needle)),
    );
  }, [data, needle]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setIncludeInactive((v) => !v)}>
          <Text style={styles.toggle}>{includeInactive ? 'Hide inactive' : 'Show inactive'}</Text>
        </TouchableOpacity>
        <Link href="/(admin)/catalog/locations/new" asChild>
          <Button title="New location" onPress={() => undefined} style={styles.newBtn} />
        </Link>
      </View>

      <View style={styles.searchWrap}>
        <Input
          icon="search"
          value={query}
          onChange={setQuery}
          placeholder="Search name or alias"
          autoCapitalize="none"
          autoCorrect={false}
          rightAdornment={
            query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Icon name="x" size={16} color="#888" />
              </TouchableOpacity>
            ) : null
          }
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
      ) : data && data.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No locations yet.</Text>
          <Text style={styles.emptySub}>Tap “New location” to add one.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(l) => l.id}
          renderItem={({ item }) => <LocationRow location={item} needle={needle} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={
            needle ? (
              <View style={styles.center}>
                <Text style={styles.empty}>No matches.</Text>
                <Text style={styles.emptySub}>
                  No location name or alias contains “{query.trim()}”.
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function LocationRow({ location, needle }: { location: Location; needle: string }) {
  const aliasCount = location.aliases?.length ?? 0;
  // When the row matched on an alias (not the name), show which alias(es) so the
  // user sees why it surfaced — and can spot the same alias on two locations.
  const matchedAliases =
    needle && !location.name.toLowerCase().includes(needle)
      ? (location.aliases ?? []).filter((a) => a.toLowerCase().includes(needle))
      : [];
  return (
    <Link
      href={{ pathname: '/(admin)/catalog/locations/[id]', params: { id: location.id } }}
      asChild
    >
      <TouchableOpacity style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={[styles.name, !location.is_active && styles.nameInactive]}>
            {location.name}
          </Text>
          <Text style={styles.meta}>
            {aliasCount === 0 ? 'no aliases' : `${aliasCount} alias${aliasCount === 1 ? '' : 'es'}`}
            {location.latitude !== null && location.longitude !== null
              ? `  •  ${Number(location.latitude).toFixed(4)}, ${Number(location.longitude).toFixed(4)}`
              : ''}
          </Text>
          {matchedAliases.length > 0 ? (
            <Text style={styles.match} numberOfLines={1}>
              matches: {matchedAliases.join(', ')}
            </Text>
          ) : null}
        </View>
        {!location.is_active ? <Text style={styles.badge}>inactive</Text> : null}
        <Text style={styles.chev}>›</Text>
      </TouchableOpacity>
    </Link>
  );
}

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
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  list: { paddingHorizontal: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowLeft: { flex: 1 },
  name: { fontSize: 16, color: '#111', fontWeight: '500' },
  nameInactive: { color: '#888', textDecorationLine: 'line-through' },
  meta: { fontSize: 13, color: '#666', marginTop: 2 },
  match: { fontSize: 12, color: '#a04000', marginTop: 2 },
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
