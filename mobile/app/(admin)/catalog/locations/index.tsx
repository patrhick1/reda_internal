import { useState, useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { listLocations, type Location } from '@/services/locations';

export default function LocationsList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => listLocations({ includeInactive }),
    [includeInactive],
  );

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

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

      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Button title="Retry" onPress={reload} variant="secondary" />
        </View>
      ) : loading && !data ? (
        <View style={styles.center}><ActivityIndicator /></View>
      ) : data && data.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No locations yet.</Text>
          <Text style={styles.emptySub}>Tap “New location” to add one.</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(l) => l.id}
          renderItem={({ item }) => <LocationRow location={item} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
        />
      )}
    </View>
  );
}

function LocationRow({ location }: { location: Location }) {
  const aliasCount = location.aliases?.length ?? 0;
  return (
    <Link href={{ pathname: '/(admin)/catalog/locations/[id]', params: { id: location.id } }} asChild>
      <TouchableOpacity style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={[styles.name, !location.is_active && styles.nameInactive]}>{location.name}</Text>
          <Text style={styles.meta}>
            {aliasCount === 0 ? 'no aliases' : `${aliasCount} alias${aliasCount === 1 ? '' : 'es'}`}
            {location.latitude !== null && location.longitude !== null
              ? `  •  ${Number(location.latitude).toFixed(4)}, ${Number(location.longitude).toFixed(4)}`
              : ''}
          </Text>
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
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  toggle: { fontSize: 14, color: '#333', fontWeight: '500' },
  newBtn: { paddingHorizontal: 14, minHeight: 36 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  list: { paddingHorizontal: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowLeft: { flex: 1 },
  name: { fontSize: 16, color: '#111', fontWeight: '500' },
  nameInactive: { color: '#888', textDecorationLine: 'line-through' },
  meta: { fontSize: 13, color: '#666', marginTop: 2 },
  badge: {
    fontSize: 11, color: '#a04000', backgroundColor: '#fde9d8',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginRight: 8, overflow: 'hidden',
  },
  chev: { fontSize: 24, color: '#bbb' },
  sep: { height: 1, backgroundColor: '#f0f0f0' },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  empty: { fontSize: 16, color: '#333', marginBottom: 4 },
  emptySub: { fontSize: 13, color: '#888' },
});
