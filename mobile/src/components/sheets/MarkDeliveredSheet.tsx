import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Button, Icon, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { getAgentProductsStock, type DeliveryRow } from '@/services/deliveries';
import { listLocations } from '@/services/locations';
import { useEnqueueChangeStatus, useEnqueueAgentChangeLocation } from '@/queue/mutations';
import { useCurrentUser } from '@/hooks/useAuth';
import { canSeePosFeeNote } from '@/lib/permissions';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

type PaymentMethod = 'cash' | 'transfer' | 'vendor_direct';

/** [Feature A] The order's lines, normalized from delivery_items (or a synthetic
 *  single line from the legacy columns for any row that predates the backfill). */
type Line = { productCatalogId: string; name: string; ordered: number };

export function MarkDeliveredSheet({
  open,
  delivery,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  onClose: () => void;
  /** Called once the mutation has been enqueued. `jobId` is the queue job
   *  the parent should watch so the optimistic veil clears once the job
   *  succeeds (removed from queue) or dead-letters (failed permanently). */
  onConfirmed: (newStatus: string, jobId: string) => void;
}) {
  // delivered quantity per product (string for the text inputs)
  const [delivered, setDelivered] = useState<Record<string, string>>({});
  const [paid, setPaid] = useState('0');
  const [method, setMethod] = useState<PaymentMethod>('transfer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onHand, setOnHand] = useState<Record<string, number> | null>(null);
  // Optional "delivered at a different area" zone change, bundled with this
  // mark-delivered. Enqueued as its own job BEFORE the delivered job so an
  // auto-applied zone re-snap lands first; a pay-raising change is held for a
  // manager and the delivery still completes at the original zone.
  const [zoneChanged, setZoneChanged] = useState(false);
  const [newZoneId, setNewZoneId] = useState<string | null>(null);
  const [zoneNote, setZoneNote] = useState('');
  const [zones, setZones] = useState<{ value: string; label: string }[]>([]);
  const { role } = useCurrentUser();
  const enqueueStatus = useEnqueueChangeStatus();
  const enqueueZoneChange = useEnqueueAgentChangeLocation();

  const lines: Line[] = useMemo(() => {
    if (!delivery) return [];
    if (delivery.items && delivery.items.length > 0) {
      return delivery.items.map((i) => ({
        productCatalogId: i.product_catalog_id,
        name: i.product_name ?? 'Product',
        ordered: i.quantity_ordered,
      }));
    }
    return delivery.product_catalog_id
      ? [
          {
            productCatalogId: delivery.product_catalog_id,
            name: delivery.product_name ?? 'Product',
            ordered: delivery.quantity_ordered ?? 1,
          },
        ]
      : [];
  }, [delivery]);
  const isMulti = lines.length > 1;
  const hasRealItems = !!delivery?.items && delivery.items.length > 0;

  // Reset form + fetch stock when the sheet OPENS (not on every delivery
  // reference change — the parent's reload() returns a new object each time).
  useEffect(() => {
    if (!open || !delivery) {
      setOnHand(null);
      return;
    }
    setDelivered(Object.fromEntries(lines.map((l) => [l.productCatalogId, String(l.ordered)])));
    setPaid(String(delivery.customer_price ?? 0));
    setMethod('transfer');
    setError(null);
    setOnHand(null);
    setZoneChanged(false);
    setNewZoneId(null);
    setZoneNote('');
    listLocations()
      .then((ls) =>
        setZones(
          ls
            .filter((l) => l.id !== delivery.location_id)
            .map((l) => ({ value: l.id, label: l.name })),
        ),
      )
      .catch(() => setZones([]));
    const agentId = delivery.assigned_agent_id;
    const productIds = lines.map((l) => l.productCatalogId);
    if (agentId && productIds.length > 0) {
      getAgentProductsStock(agentId, productIds)
        .then(setOnHand)
        .catch(() => setOnHand(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, delivery?.id]);

  const paidNum = Number(paid);

  // Per-line numbers (delivered qty, stock-short) computed up front. Any
  // undelivered remainder stays on the agent's hand — agents keep leftover
  // product 100% of the time, so there is no return-to-warehouse option here.
  const perLine = useMemo(
    () =>
      lines.map((l) => {
        const qd = Number(delivered[l.productCatalogId] ?? '');
        const valid = Number.isInteger(qd) && qd > 0;
        const oh = onHand?.[l.productCatalogId];
        const short = valid && oh != null && qd > oh;
        return { ...l, qd, valid, onHand: oh, short };
      }),
    [lines, delivered, onHand],
  );
  const anyShort = perLine.some((p) => p.short);
  const totalDelivered = perLine.reduce((s, p) => s + (p.valid ? p.qd : 0), 0);

  // All money fields are per-delivery. Delivered quantity tracks stock movement
  // and partial state; it does NOT scale the money.
  const expectedTotal = Number(delivery?.customer_price ?? 0);
  const agentEarn = Number(delivery?.agent_payment_snapshot ?? 0);
  // 'vendor_direct' = the customer paid the vendor directly, so the agent
  // collects nothing — paid is forced to 0. The agent fee is still owed (Reda
  // pays it) and the Reda fee is still billed to the vendor; both are derived
  // server-side from the creation snapshots, so there's nothing extra to send.
  const isVendorDirect = method === 'vendor_direct';
  const effectivePaid = isVendorDirect ? 0 : paidNum;
  const remit = effectivePaid - agentEarn;
  const diff = effectivePaid - expectedTotal;
  const cashPosFee = method === 'cash' && effectivePaid > 0 ? 500 : 0;

  if (!delivery) return null;

  async function submit() {
    setError(null);
    if (perLine.length === 0) {
      setError('No products on this delivery');
      return;
    }
    for (const p of perLine) {
      if (!p.valid) {
        setError(`Enter a positive quantity for ${p.name}`);
        return;
      }
      if (p.onHand != null && p.qd > p.onHand) {
        setError(`You only have ${p.onHand} ${p.name} on hand`);
        return;
      }
    }
    if (!isVendorDirect && (!Number.isFinite(paidNum) || paidNum < 0)) {
      setError('Paid must be ≥ 0');
      return;
    }
    setSubmitting(true);
    try {
      // Enqueue the zone change FIRST so an auto-applied re-snap lands before the
      // delivered job; a pay-raising change is held for a manager and delivered
      // proceeds at the original zone. Order-independent server-side regardless.
      if (zoneChanged && newZoneId && newZoneId !== delivery!.location_id) {
        await enqueueZoneChange(
          {
            deliveryId: delivery!.id ?? '',
            toLocationId: newZoneId,
            reason: zoneNote.trim() || 'Delivered at a different area than ordered',
          },
          `Zone change · ${delivery!.customer_name ?? ''}`,
        );
      }
      const jobId = await enqueueStatus(
        {
          deliveryId: delivery!.id ?? '',
          toStatus: 'delivered',
          reason: null,
          notes: null,
          quantityDelivered: totalDelivered,
          paid: effectivePaid,
          paymentMethod: method,
          newScheduledDate: null,
          // Pass per-line quantities only when real delivery_items exist; for a
          // legacy row with none, the server fans totalDelivered onto its line.
          itemQuantities: hasRealItems
            ? perLine.map((p) => ({
                productCatalogId: p.productCatalogId,
                quantityDelivered: p.qd,
              }))
            : undefined,
        },
        `Mark delivered · ${delivery!.customer_name ?? ''}`,
      );
      onConfirmed('delivered', jobId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title="Mark delivered"
      subtitle={`${delivery.customer_name} · ${
        isMulti ? `${lines.length} items` : (delivery.product_name ?? '—')
      }`}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="emphasis" full icon="check" onPress={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Confirm delivery'}
          </Button>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 18, paddingBottom: 8 }}>
        {/* Quantity delivered — one field per product line */}
        <View style={{ gap: 12 }}>
          {perLine.map((p) => (
            <View key={p.productCatalogId} style={{ gap: 4 }}>
              <Input
                label={isMulti ? `${p.name} — qty delivered` : 'Quantity delivered'}
                value={delivered[p.productCatalogId] ?? ''}
                onChange={(v) => setDelivered((d) => ({ ...d, [p.productCatalogId]: v }))}
                keyboardType="numeric"
                autoCapitalize="none"
                helper={
                  p.onHand != null
                    ? `On hand: ${p.onHand}${isMulti ? '' : ''} · ordered ${p.ordered}`
                    : `Ordered ${p.ordered}`
                }
              />
              {p.short ? (
                <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.red }}>
                  {`Only ${p.onHand} ${p.name} on hand — pick up from the warehouse first.`}
                </Text>
              ) : p.qd > p.ordered ? (
                <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.infoDark }}>
                  {`Upsell: ${p.qd - p.ordered} more than ordered.`}
                </Text>
              ) : null}
            </View>
          ))}
        </View>

        {anyShort ? (
          <Banner tone="error" icon="alert" title="Not enough stock">
            Pick up the short products from the warehouse before marking delivered.
          </Banner>
        ) : null}

        {isVendorDirect ? (
          <Banner tone="info" icon="alert" title="Paid to vendor">
            The customer paid the vendor directly — you collect ₦0. Reda still pays your earnings
            and bills the vendor its fee.
          </Banner>
        ) : (
          <Input
            label="Amount collected (₦)"
            value={paid}
            onChange={setPaid}
            keyboardType="numeric"
            autoCapitalize="none"
            helper={`Expected: ${formatNaira(expectedTotal)}`}
          />
        )}

        <View>
          <Text
            style={{
              fontFamily: fonts.semibold,
              fontSize: 12,
              color: colors.textSecondary,
              marginBottom: 8,
            }}
          >
            Payment method
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['cash', 'transfer', 'vendor_direct'] as const).map((m) => {
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
                      paddingHorizontal: 4,
                      borderRadius: 12,
                      borderWidth: 2,
                      borderColor: active ? colors.black : colors.border,
                      backgroundColor: active ? colors.black : colors.white,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 6,
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Icon
                    name={m === 'cash' ? 'cash' : m === 'transfer' ? 'bank' : 'user'}
                    size={18}
                    color={active ? colors.white : colors.black}
                  />
                  <Text
                    style={{
                      fontFamily: fonts.bold,
                      fontSize: 13,
                      color: active ? colors.white : colors.black,
                    }}
                  >
                    {m === 'cash' ? 'Cash' : m === 'transfer' ? 'Transfer' : 'To vendor'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View>
          <Pressable
            onPress={() => setZoneChanged((v) => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                borderWidth: 2,
                borderColor: zoneChanged ? colors.black : colors.border,
                backgroundColor: zoneChanged ? colors.black : colors.white,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {zoneChanged ? <Icon name="check" size={14} color={colors.white} /> : null}
            </View>
            <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.black }}>
              Delivered at a different area?
            </Text>
          </Pressable>
          {zoneChanged ? (
            <View style={{ gap: 10, marginTop: 12 }}>
              <Select
                label="Actual delivery zone"
                value={newZoneId}
                options={zones}
                onChange={setNewZoneId}
                placeholder="Pick the zone you delivered to"
              />
              <Input
                label="Note (optional)"
                value={zoneNote}
                onChange={setZoneNote}
                placeholder="e.g. customer moved to VI"
                autoCapitalize="sentences"
              />
              <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}>
                If this raises your delivery pay, a manager approves it first. Otherwise it applies
                right away.
              </Text>
            </View>
          ) : null}
        </View>

        {!isVendorDirect && Number.isFinite(diff) && diff !== 0 ? (
          <Banner tone="warn" icon="alert" title={diff < 0 ? 'Underpayment' : 'Overpayment'}>
            {`Difference of ${formatNaira(Math.abs(diff))}. Remit will reflect the actual paid amount.`}
          </Banner>
        ) : null}

        {cashPosFee > 0 && canSeePosFeeNote(role) ? (
          <Banner tone="info" icon="cash" title="POS fee on cash">
            {`${formatNaira(cashPosFee)} will be deducted from the client's remit (POS charge for banking the cash). Doesn't change what you hand over.`}
          </Banner>
        ) : null}

        <View style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 6 }}>
          <SummaryRow label="Your earnings" value={formatNaira(agentEarn)} />
          {isVendorDirect ? (
            <SummaryRow label="To remit to Reda" value={formatNaira(0)} />
          ) : (
            <SummaryRow label="Remit to Reda" value={formatNaira(remit)} />
          )}
        </View>

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <Banner tone="warn" icon="alert">
          Marking delivered is final — you can’t undo it from the app.
        </Banner>
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
