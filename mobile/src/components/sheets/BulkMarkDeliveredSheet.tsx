import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Button, Icon, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { type DeliveryRow } from '@/services/deliveries';
import { useEnqueueChangeStatus } from '@/queue/mutations';
import { canBulkDeliverRow } from '@/lib/permissions';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

type PaymentMethod = 'cash' | 'transfer';

/** Agent bulk "Mark delivered". Each selected order is marked delivered with
 *  ITS OWN customer_price as the amount paid and quantity_ordered as the
 *  quantity — the "everyone paid in full" fast path. Payment method is a
 *  single shared toggle for the batch (default transfer — ~98% of deliveries).
 *  Each eligible row enqueues its own change_delivery_status job, so the action
 *  is offline-resilient and every row is ownership/stock-checked server-side
 *  exactly like a single delivery. */
export function BulkMarkDeliveredSheet({
  open,
  selected,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  /** Full DeliveryRow objects for the current selection — lets the sheet
   *  compute per-row paid/quantity and the eligibility preview with no
   *  extra roundtrip. */
  selected: DeliveryRow[];
  onClose: () => void;
  /** Fired once all eligible jobs are enqueued. `count` is how many delivered
   *  jobs were queued; parent exits select mode, toasts, and reloads. */
  onConfirmed: (count: number) => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('transfer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueStatus = useEnqueueChangeStatus();

  // Reset to the default each time the sheet opens so a previous batch's Cash
  // choice never silently carries into the next one (the Cancel button closes
  // via the parent and wouldn't otherwise reset local state).
  useEffect(() => {
    if (open) {
      setMethod('transfer');
      setError(null);
    }
  }, [open]);

  // `canBulkDeliverRow` here is a backstop — the Today screen already gates
  // selection to eligible rows, so `selected` should never contain an
  // ineligible one. The `!!d.id` guard makes a job with an empty id
  // structurally impossible.
  const eligible = useMemo(
    () => selected.filter((d) => !!d.id && canBulkDeliverRow(d)),
    [selected],
  );
  const totalExpected = useMemo(
    () => eligible.reduce((sum, d) => sum + Number(d.customer_price ?? 0), 0),
    [eligible],
  );
  const cashPosFeeTotal = method === 'cash' ? eligible.length * 500 : 0;

  async function submit() {
    if (eligible.length === 0) return;
    setSubmitting(true);
    setError(null);
    // Count what actually enqueued so a mid-loop failure (rare — enqueue is a
    // local write) still acknowledges the jobs that DID queue rather than
    // leaving them to drain silently with no toast.
    let enqueued = 0;
    try {
      for (const d of eligible) {
        // [Feature A] Bulk = deliver every line in full. Build per-item
        // quantities from delivery_items (each delivered at its ordered qty);
        // fall back to the legacy single quantity for rows without items.
        const hasItems = !!d.items && d.items.length > 0;
        const itemQuantities = hasItems
          ? d.items.map((it) => ({
              productCatalogId: it.product_catalog_id,
              quantityDelivered: it.quantity_ordered,
            }))
          : undefined;
        const totalQty = hasItems
          ? d.items.reduce((s, it) => s + it.quantity_ordered, 0)
          : (d.quantity_ordered ?? 1);
        // Each enqueue() mints its own clientUuid, so the N jobs are
        // independently idempotent on retry / re-drain.
        await enqueueStatus(
          {
            deliveryId: d.id!,
            toStatus: 'delivered',
            reason: null,
            notes: null,
            quantityDelivered: totalQty,
            paid: Number(d.customer_price ?? 0),
            paymentMethod: method,
            newScheduledDate: null,
            itemQuantities,
          },
          `Mark delivered · ${d.customer_name ?? ''}`,
        );
        enqueued++;
      }
      onConfirmed(enqueued);
    } catch (e) {
      setError(`${errorMessage(e)} (${enqueued} of ${eligible.length} queued)`);
      // Acknowledge the ones that did queue so the parent can reflect them.
      if (enqueued > 0) onConfirmed(enqueued);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Mark delivered"
      subtitle={`${selected.length} selected`}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="info" icon="check">
          Marks each order paid in full at its own price. For partial or short payments, do that
          order on its own.
        </Banner>

        <View>
          <Text
            style={{
              fontFamily: fonts.semibold,
              fontSize: 12,
              color: colors.textSecondary,
              marginBottom: 8,
            }}
          >
            Payment method (applies to all)
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['transfer', 'cash'] as const).map((m) => {
              const active = method === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMethod(m)}
                  style={({ pressed }) => [
                    {
                      flex: 1,
                      minHeight: 56,
                      paddingVertical: 12,
                      borderRadius: 12,
                      borderWidth: 2,
                      borderColor: active ? colors.black : colors.border,
                      backgroundColor: active ? colors.black : colors.white,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 8,
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Icon
                    name={m === 'cash' ? 'cash' : 'bank'}
                    size={18}
                    color={active ? colors.white : colors.black}
                  />
                  <Text
                    style={{
                      fontFamily: fonts.bold,
                      fontSize: 14,
                      color: active ? colors.white : colors.black,
                    }}
                  >
                    {m === 'cash' ? 'Cash' : 'Transfer'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {cashPosFeeTotal > 0 ? (
          <Banner tone="info" icon="cash" title="POS fee on cash">
            {`${formatNaira(500)} per order (${formatNaira(cashPosFeeTotal)} total) is deducted from each client's remit for banking the cash. Doesn't change what you hand over.`}
          </Banner>
        ) : null}

        <View style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 6 }}>
          <SummaryRow label="Orders to mark delivered" value={String(eligible.length)} />
          <SummaryRow label="Total expected" value={formatNaira(totalExpected)} />
        </View>

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <View style={{ flex: 1 }}>
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={submit}
              disabled={submitting || eligible.length === 0}
            >
              {submitting
                ? 'Saving…'
                : eligible.length === 0
                  ? 'Nothing eligible'
                  : `Mark ${eligible.length} delivered`}
            </Button>
          </View>
        </View>
      </View>
    </Sheet>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>{value}</Text>
    </View>
  );
}
