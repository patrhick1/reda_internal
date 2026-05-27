import { useCallback } from 'react';
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
import { useAsync } from '@/hooks/useAsync';
import { listCurrentRates, type LocationRate } from '@/services/rate-card';
import { formatNaira } from '@/lib/format';

export default function RatesMatrix() {
  const { data, loading, error, reload } = useAsync(() => listCurrentRates(), []);
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Button title="Retry" onPress={reload} variant="secondary" />
      </View>
    );
  }
  if (loading && !data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if ((data ?? []).length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No active locations yet.</Text>
        <Text style={styles.emptySub}>Add a location first.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={[styles.cell, styles.cellLoc, styles.headerText]}>Location</Text>
        <Text style={[styles.cell, styles.cellNum, styles.headerText]}>Charged</Text>
        <Text style={[styles.cell, styles.cellNum, styles.headerText]}>Agent</Text>
        <Text style={[styles.cell, styles.cellNum, styles.headerText]}>Margin</Text>
      </View>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.location_id}
        renderItem={({ item }) => <Row row={item} />}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
      />
    </View>
  );
}

function Row({ row }: { row: LocationRate }) {
  const hasRate = row.charged !== null && row.agent_payment !== null;
  const margin = hasRate ? (row.charged as number) - (row.agent_payment as number) : null;

  return (
    <Link
      href={{
        pathname: '/(admin)/catalog/rates/[locationId]',
        params: { locationId: row.location_id },
      }}
      asChild
    >
      <TouchableOpacity style={styles.dataRow}>
        <Text style={[styles.cell, styles.cellLoc, styles.name]} numberOfLines={1}>
          {row.location_name}
        </Text>
        {hasRate ? (
          <>
            <Text style={[styles.cell, styles.cellNum]}>{formatNaira(row.charged)}</Text>
            <Text style={[styles.cell, styles.cellNum]}>{formatNaira(row.agent_payment)}</Text>
            <Text style={[styles.cell, styles.cellNum, styles.margin]}>{formatNaira(margin)}</Text>
          </>
        ) : (
          <Text style={[styles.cell, styles.cellNoRate]}>No rate yet — tap to set</Text>
        )}
      </TouchableOpacity>
    </Link>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  empty: { fontSize: 16, color: '#333', marginBottom: 4 },
  emptySub: { fontSize: 13, color: '#888' },
  headerRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#fafafa',
  },
  dataRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  sep: { height: 1, backgroundColor: '#f0f0f0' },
  cell: { fontSize: 14, color: '#111' },
  cellLoc: { flex: 2 },
  cellNum: { flex: 1, textAlign: 'right' },
  cellNoRate: { flex: 3, textAlign: 'right', color: '#888', fontStyle: 'italic', fontSize: 13 },
  headerText: {
    color: '#666',
    fontWeight: '600',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  name: { fontWeight: '500' },
  margin: { fontWeight: '600', color: '#0a7a3a' },
});
