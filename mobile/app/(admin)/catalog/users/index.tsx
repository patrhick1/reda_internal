import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Link } from 'expo-router';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { listUsers, type AppUser } from '@/services/users';

export default function UsersList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => listUsers({ includeInactive }),
    [includeInactive],
  );
  useReloadOnFocus(reload);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setIncludeInactive((v) => !v)}>
          <Text style={styles.toggle}>{includeInactive ? 'Hide inactive' : 'Show inactive'}</Text>
        </TouchableOpacity>
        <Link href="/(admin)/catalog/users/new" asChild>
          <Button title="New user" onPress={() => undefined} style={styles.newBtn} />
        </Link>
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
      ) : (data ?? []).length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No users yet.</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => <UserRow user={item} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
        />
      )}
    </View>
  );
}

function UserRow({ user }: { user: AppUser }) {
  return (
    <Link href={{ pathname: '/(admin)/catalog/users/[id]', params: { id: user.id } }} asChild>
      <TouchableOpacity style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={[styles.name, !user.is_active && styles.nameInactive]}>
            {user.display_name}
          </Text>
          <Text style={styles.meta}>
            {user.email}
            {user.phone ? `  •  ${user.phone}` : ''}
          </Text>
        </View>
        <Text style={[styles.roleBadge, roleStyles[user.role]]}>{user.role}</Text>
        {!user.is_active ? <Text style={styles.inactive}>inactive</Text> : null}
        <Text style={styles.chev}>›</Text>
      </TouchableOpacity>
    </Link>
  );
}

const roleStyles: Record<AppUser['role'], { backgroundColor: string; color: string }> = {
  admin: { backgroundColor: '#fde9d8', color: '#a04000' },
  dispatcher: { backgroundColor: '#e2efff', color: '#1a4b8c' },
  rep: { backgroundColor: '#e6ebff', color: '#2a3a7a' },
  agent: { backgroundColor: '#e0f3e7', color: '#0a7a3a' },
  warehouse: { backgroundColor: '#f0e6f7', color: '#5a3380' },
};

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
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowLeft: { flex: 1 },
  name: { fontSize: 16, color: '#111', fontWeight: '500' },
  nameInactive: { color: '#888', textDecorationLine: 'line-through' },
  meta: { fontSize: 13, color: '#666', marginTop: 2 },
  roleBadge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
    overflow: 'hidden',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inactive: {
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
  empty: { fontSize: 16, color: '#333' },
});
