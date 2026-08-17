import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppBar, Banner, Button, Card, Empty, Input, Sheet, StatusPill } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { newClientUuid } from '@/lib/uuid';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listUsers, isWarehousePlace } from '@/services/users';
import {
  listReplacementReturns,
  receiveReplacementReturn,
  type ReplacementReturnDisposition,
  type ReplacementReturnQueueRow,
} from '@/services/replacements';

const DISPOSITION_LABELS: Record<ReplacementReturnDisposition, string> = {
  accept_to_stock: 'Inspected usable — add to warehouse stock',
  hold_for_vendor: 'Receive and hold separately for vendor',
  reject_damaged: 'Damaged — keep out of usable stock',
  returned_to_vendor: 'Handed back to vendor',
};

export function ReplacementReturnsScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const rowsQ = useAsync(() => listReplacementReturns(), []);
  const warehousesQ = useAsync(
    () =>
      user.role === 'warehouse'
        ? Promise.resolve([])
        : listUsers().then((users) => users.filter(isWarehousePlace)),
    [user.role],
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReplacementReturnQueueRow | null>(null);
  const [disposition, setDisposition] = useState<ReplacementReturnDisposition | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rowsQ.data ?? [];
    return (rowsQ.data ?? []).filter((row) =>
      `${row.customer_name} ${row.client_name} ${row.product_name} ${row.rider_name ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [rowsQ.data, query]);

  const warehouseOptions = (warehousesQ.data ?? []).map((warehouse) => ({
    value: warehouse.id,
    label: warehouse.display_name,
  }));
  const managerNeedsWarehouse = user.role !== 'warehouse';
  const canAccept = selected?.reported_condition === 'usable';

  function close() {
    if (submitting) return;
    setSelected(null);
    setDisposition(null);
    setWarehouseId(null);
    setNotes('');
    setError(null);
  }

  async function submit() {
    if (!selected || !disposition) return;
    if (managerNeedsWarehouse && !warehouseId) {
      setError('Select the warehouse receiving this item.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await receiveReplacementReturn({
        clientUuid: newClientUuid(),
        returnItemId: selected.return_item_id,
        disposition,
        warehouseId: managerNeedsWarehouse ? warehouseId : null,
        notes: notes.trim() || null,
      });
      closeAfterSuccess();
      rowsQ.reload();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  function closeAfterSuccess() {
    setSubmitting(false);
    setSelected(null);
    setDisposition(null);
    setWarehouseId(null);
    setNotes('');
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Replacement returns"
        subtitle="Inspect custody before changing usable stock"
        onBack={() => router.back()}
      />
      <View style={{ padding: 16, gap: 10 }}>
        <Banner tone="info" icon="package">
          Rider custody is separate from stock. Only choose “add to stock” after you physically
          receive and inspect an undamaged item.
        </Banner>
        <Input
          icon="search"
          value={query}
          onChange={setQuery}
          placeholder="Search customer, vendor, product, or rider"
        />
      </View>
      <FlatList
        data={visible}
        keyExtractor={(row) => row.return_item_id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 8 }}
        refreshControl={
          <RefreshControl refreshing={rowsQ.loading && !!rowsQ.data} onRefresh={rowsQ.reload} />
        }
        ListEmptyComponent={
          rowsQ.loading && !rowsQ.data ? (
            <View style={{ padding: 60 }}><ActivityIndicator color={colors.black} /></View>
          ) : rowsQ.error ? (
            <Banner tone="error" icon="alert">{rowsQ.error}</Banner>
          ) : (
            <Empty
              icon="check"
              title={query ? 'No matching returns' : 'No returns waiting'}
              sub={query ? 'Try a different search.' : 'Collected replacement items will appear here.'}
            />
          )
        }
        renderItem={({ item }) => (
          <Card dense onPress={() => setSelected(item)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={customer}>{item.customer_name}</Text>
                <Text style={product}>{item.product_name} · Qty {item.quantity}</Text>
                <Text style={meta}>{item.client_name} · with {item.rider_name ?? 'rider'}</Text>
                <Text style={address} numberOfLines={2}>{item.raw_address}</Text>
              </View>
              <StatusPill
                status={item.reported_condition === 'usable' ? 'available' : 'failed_delivery'}
              />
            </View>
          </Card>
        )}
      />

      <Sheet
        open={!!selected}
        onClose={close}
        title="Receive replacement return"
        subtitle={selected ? `${selected.product_name} · ${selected.customer_name}` : undefined}
        footer={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button variant="secondary" onPress={close} disabled={submitting}>Cancel</Button>
            <Button full variant="emphasis" onPress={submit} disabled={submitting || !disposition}>
              {submitting ? 'Saving…' : 'Confirm custody'}
            </Button>
          </View>
        }
      >
        <View style={{ padding: 20, gap: 16 }}>
          {selected?.reported_condition === 'damaged' ? (
            <Banner tone="warn" icon="alert" title="Reported damaged">
              This item cannot be added to usable stock. Hold it separately for the vendor, reject it,
              or record that it was returned to the vendor.
            </Banner>
          ) : (
            <Banner tone="info" icon="eye" title="Inspect it yourself">
              The rider reported it as usable. Confirm the physical condition before adding it to stock.
            </Banner>
          )}
          <Select
            label="Warehouse decision"
            value={disposition}
            options={(Object.entries(DISPOSITION_LABELS) as [ReplacementReturnDisposition, string][])
              .filter(([value]) => value !== 'accept_to_stock' || canAccept)
              .map(([value, label]) => ({ value, label }))}
            onChange={setDisposition}
            required
          />
          {managerNeedsWarehouse ? (
            <Select
              label="Receiving warehouse"
              value={warehouseId}
              options={warehouseOptions}
              onChange={setWarehouseId}
              placeholder={warehousesQ.loading ? 'Loading warehouses…' : 'Select warehouse'}
              required
            />
          ) : null}
          <Input
            label="Inspection / handoff note"
            value={notes}
            onChange={setNotes}
            multiline
            placeholder="Condition seen, storage location, or vendor instruction"
          />
          {error ? <Banner tone="error" icon="alert">{error}</Banner> : null}
        </View>
      </Sheet>
    </View>
  );
}

const customer = { fontFamily: fonts.bold, fontSize: 15, color: colors.black };
const product = { fontFamily: fonts.semibold, fontSize: 13, color: colors.black, marginTop: 4 };
const meta = { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 3 };
const address = { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 5, lineHeight: 17 };
