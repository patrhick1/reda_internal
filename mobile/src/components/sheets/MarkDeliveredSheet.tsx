import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Button, Icon, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { getAgentProductStock, type DeliveryRow } from '@/services/deliveries';
import { useEnqueueChangeStatus, useEnqueueReturnLeftover } from '@/queue/mutations';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

type PaymentMethod = 'cash' | 'transfer';

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
  const [qty, setQty] = useState('1');
  const [paid, setPaid] = useState('0');
  const [method, setMethod] = useState<PaymentMethod>('transfer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onHand, setOnHand] = useState<number | null>(null);
  const [returnLeftover, setReturnLeftover] = useState(false);
  const enqueueStatus = useEnqueueChangeStatus();
  const enqueueReturnLeftover = useEnqueueReturnLeftover();

  // Reset form + fetch stock when the sheet OPENS, not on every delivery
  // reference change. The parent's reload() returns a new `delivery` object
  // each time, which would otherwise re-fire this effect and waste queries
  // on a closed sheet.
  useEffect(() => {
    if (!open || !delivery) {
      setOnHand(null);
      return;
    }
    setQty(String(delivery.quantity_ordered ?? 1));
    // customer_price is per-delivery (what the agent collects from the
    // customer for this trip, flat — not the product unit price).
    setPaid(String(delivery.customer_price ?? 0));
    setMethod('transfer');
    setReturnLeftover(false);
    setError(null);
    setOnHand(null);
    const agentId = delivery.assigned_agent_id;
    const productId = delivery.product_catalog_id;
    if (agentId && productId) {
      getAgentProductStock(agentId, productId)
        .then(setOnHand)
        .catch(() => setOnHand(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, delivery?.id]);

  if (!delivery) return null;

  const qtyNum = Number(qty);
  const paidNum = Number(paid);
  const stockShort = onHand !== null && Number.isInteger(qtyNum) && qtyNum > 0 && qtyNum > onHand;
  // Doorstep upsell: customer buys more than originally ordered. Server
  // bumps quantity_ordered to match; money stays whatever the agent typed.
  const upsellDelta =
    delivery.quantity_ordered != null &&
    Number.isInteger(qtyNum) &&
    qtyNum > delivery.quantity_ordered
      ? qtyNum - delivery.quantity_ordered
      : 0;
  // Partial delivery: units the customer didn't take. current_stock only
  // subtracts quantity_delivered, so without an explicit return these stay on
  // the agent's books (§14-1). Offer to hand them back to the warehouse.
  const leftover =
    delivery.quantity_ordered != null &&
    Number.isInteger(qtyNum) &&
    qtyNum > 0 &&
    qtyNum < delivery.quantity_ordered
      ? delivery.quantity_ordered - qtyNum
      : 0;
  // All three money fields below are per-delivery. quantity_delivered tracks
  // stock movement and partial-delivery state; it does NOT scale the money.
  const expectedTotal = Number(delivery.customer_price ?? 0);
  const agentEarn = Number(delivery.agent_payment_snapshot ?? 0);
  const remit = paidNum - agentEarn;
  const diff = paidNum - expectedTotal;
  // Cash POS fee — informational only at this surface. The agent still
  // hands over the full `paid` amount; the ₦500 lives on the client-remit
  // side of the books (charged when Reda banks the cash). Showing it here
  // so agents understand why cash and transfer look different on the
  // reconciliation reports the client sees.
  const cashPosFee = method === 'cash' && paidNum > 0 ? 500 : 0;

  async function submit() {
    setError(null);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      setError('Quantity must be a positive whole number');
      return;
    }
    if (onHand !== null && qtyNum > onHand) {
      setError(`You only have ${onHand} on hand for this product`);
      return;
    }
    if (!Number.isFinite(paidNum) || paidNum < 0) {
      setError('Paid must be ≥ 0');
      return;
    }
    setSubmitting(true);
    try {
      const jobId = await enqueueStatus(
        {
          deliveryId: delivery!.id ?? '',
          toStatus: 'delivered',
          reason: null,
          notes: null,
          quantityDelivered: qtyNum,
          paid: paidNum,
          paymentMethod: method,
          newScheduledDate: null,
        },
        `Mark delivered · ${delivery!.customer_name ?? ''}`,
      );
      // Queued AFTER the delivered job; the queue drains FIFO so the row is
      // already 'delivered' by the time this runs (and the RPC retries if not).
      if (returnLeftover && leftover > 0) {
        await enqueueReturnLeftover(
          { deliveryId: delivery!.id ?? '', quantity: leftover, notes: null },
          `Return ${leftover} to warehouse · ${delivery!.customer_name ?? ''}`,
        );
      }
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
      subtitle={`${delivery.customer_name} · ${delivery.product_name ?? '—'}`}
    >
      <View style={{ padding: 20, gap: 18, paddingBottom: 32 }}>
        <Input
          label="Quantity delivered"
          value={qty}
          onChange={setQty}
          keyboardType="numeric"
          autoCapitalize="none"
          helper={onHand !== null ? `On hand: ${onHand}` : undefined}
        />
        {stockShort ? (
          <Banner tone="error" icon="alert" title="Not enough stock">
            {`You only have ${onHand} on hand for this product. Pick up from the warehouse before marking delivered.`}
          </Banner>
        ) : null}
        {upsellDelta > 0 && !stockShort ? (
          <Banner tone="info" icon="alert" title="Customer is buying more">
            {`Customer ordered ${delivery.quantity_ordered}, you're delivering ${qtyNum}. Type the new amount they paid in the field below.`}
          </Banner>
        ) : null}
        <Input
          label="Amount collected (₦)"
          value={paid}
          onChange={setPaid}
          keyboardType="numeric"
          autoCapitalize="none"
          helper={`Expected: ${formatNaira(expectedTotal)}`}
        />

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
            {(['cash', 'transfer'] as const).map((m) => {
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

        {Number.isFinite(diff) && diff !== 0 ? (
          <Banner tone="warn" icon="alert" title={diff < 0 ? 'Underpayment' : 'Overpayment'}>
            {`Difference of ${formatNaira(Math.abs(diff))}. Remit will reflect the actual paid amount.`}
          </Banner>
        ) : null}

        {cashPosFee > 0 ? (
          <Banner tone="info" icon="cash" title="POS fee on cash">
            {`${formatNaira(cashPosFee)} will be deducted from the client's remit (POS charge for banking the cash). Doesn't change what you hand over.`}
          </Banner>
        ) : null}

        {leftover > 0 ? (
          <Pressable
            onPress={() => setReturnLeftover((v) => !v)}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 14,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: returnLeftover ? colors.black : colors.border,
                backgroundColor: returnLeftover ? colors.surface : colors.white,
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                borderWidth: 2,
                borderColor: returnLeftover ? colors.black : colors.border,
                backgroundColor: returnLeftover ? colors.black : colors.white,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {returnLeftover ? <Icon name="check" size={16} color={colors.white} /> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>
                {`Return ${leftover} to warehouse`}
              </Text>
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
                {`You're delivering ${qtyNum} of ${delivery.quantity_ordered}. Leave this off to keep the ${leftover} with you.`}
              </Text>
            </View>
          </Pressable>
        ) : null}

        <View style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, gap: 6 }}>
          <SummaryRow label="Your earnings" value={formatNaira(agentEarn)} />
          <SummaryRow label="Remit to Reda" value={formatNaira(remit)} />
        </View>

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <Banner tone="warn" icon="alert">
          Marking delivered is final — you can’t undo it from the app.
        </Banner>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="emphasis" full icon="check" onPress={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Confirm delivery'}
          </Button>
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
