import { useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { listClients, type Client } from '@/services/clients';

export default function ClientsList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => listClients({ includeInactive }),
    [includeInactive],
  );

  // Re-fetch when this screen comes back into focus (e.g., after creating a client)
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setIncludeInactive((v) => !v)}>
          <Text style={styles.toggle}>
            {includeInactive ? 'Hide inactive' : 'Show inactive'}
          </Text>
        </TouchableOpacity>
        <Link href="/(admin)/catalog/clients/new" asChild>
          <Button title="New client" onPress={() => undefined} style={styles.newBtn} />
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
          <Text style={styles.empty}>No clients yet.</Text>
          <Text style={styles.emptySub}>Tap “New client” to add one.</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <ClientRow client={item} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
        />
      )}
    </View>
  );
}

function ClientRow({ client }: { client: Client }) {
  return (
    <Link href={{ pathname: '/(admin)/catalog/clients/[id]', params: { id: client.id } }} asChild>
      <TouchableOpacity style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={[styles.name, !client.is_active && styles.nameInactive]}>{client.name}</Text>
          {client.contact_phone || client.contact_email ? (
            <Text style={styles.meta}>
              {[client.contact_phone, client.contact_email].filter(Boolean).join('  •  ')}
            </Text>
          ) : null}
        </View>
        {!client.is_active ? <Text style={styles.badge}>inactive</Text> : null}
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  list: { paddingHorizontal: 16, paddingVertical: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
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
