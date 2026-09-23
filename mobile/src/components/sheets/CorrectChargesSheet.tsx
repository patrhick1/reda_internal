import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { newClientUuid } from '@/lib/uuid';
import {
  PAY_ISSUE_TEXT,
  previewFeeAdjustment,
  saveFeeAdjustment,
  type FeePreview,
} from '@/services/fee-adjustments';

export function CorrectChargesSheet({
  open,
  deliveryId,
  customerName,
  onClose,
  onCorrected,
  riderOnly = false,
}: {
  open: boolean;
  deliveryId: string | null;
  currentCharged: number | null;
  currentAgentPayment: number | null;
  customerName: string | null;
  onClose: () => void;
  onCorrected: () => void;
  riderOnly?: boolean;
}) {
  const [charged, setCharged] = useState('');
  const [chargedEdited, setChargedEdited] = useState(false);
  const [missingClientCharge, setMissingClientCharge] = useState(false);
  const [agentPayment, setAgentPayment] = useState('');
  const [agentEdited, setAgentEdited] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{ key: string; data: FeePreview } | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const busy = useRef(false);
  const baseRevision = useRef<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const chargedNum = Number(charged);
  const agentNum = Number(agentPayment);
  const valid =
    charged.trim() !== '' &&
    agentPayment.trim() !== '' &&
    [chargedNum, agentNum].every(
      (n) =>
        Number.isFinite(n) &&
        n >= 0 &&
        n <= 99999999.99 &&
        Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    );
  const applyAgentOverride = riderOnly || agentEdited;
  const key = JSON.stringify([deliveryId, charged, agentPayment, applyAgentOverride, refresh]);
  const current = preview?.key === key ? preview.data : null;
  const changed = current && (applyAgentOverride || chargedNum !== current.charged);

  useEffect(() => {
    if (!open || !deliveryId) return;
    let cancelled = false;
    setReady(false);
    setError(null);
    setPreview(null);
    setReason('');
    setAgentEdited(false);
    setChargedEdited(false);
    baseRevision.current = null;
    request.current = null;
    void previewFeeAdjustment(deliveryId)
      .then((data) => {
        if (cancelled) return;
        baseRevision.current = data.revision;
        setMissingClientCharge(data.charged == null);
        setCharged(data.charged == null ? '' : String(data.charged));
        const amount = riderOnly
          ? (data.orders.find((order) => order.delivery_id === deliveryId)?.amount ??
            data.agent_payment)
          : data.agent_payment;
        setAgentPayment(amount == null ? '' : String(amount));
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, deliveryId, riderOnly]);

  useEffect(() => {
    if (!open || !deliveryId || !ready || !valid) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewFeeAdjustment(deliveryId, chargedNum, agentNum, applyAgentOverride)
        .then((data) => {
          if (!cancelled) {
            if (data.revision !== baseRevision.current) {
              setPreview(null);
              setError(
                'These orders changed while you were editing. Refresh the amounts before saving.',
              );
              return;
            }
            setPreview({ key, data });
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(errorMessage(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, deliveryId, ready, valid, chargedNum, agentNum, applyAgentOverride, key]);

  async function refreshAmounts() {
    if (!deliveryId || busy.current) return;
    setPreview(null);
    try {
      const data = await previewFeeAdjustment(deliveryId);
      baseRevision.current = data.revision;
      if (!chargedEdited) {
        setMissingClientCharge(data.charged == null);
        setCharged(data.charged == null ? '' : String(data.charged));
      }
      if (!agentEdited) {
        const amount = riderOnly
          ? (data.orders.find((order) => order.delivery_id === deliveryId)?.amount ??
            data.agent_payment)
          : data.agent_payment;
        setAgentPayment(amount == null ? '' : String(amount));
      }
      setReady(true);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function submit() {
    if (
      !deliveryId ||
      !current ||
      !valid ||
      !reason.trim() ||
      !changed ||
      current.settled ||
      busy.current
    )
      return;
    const input = {
      deliveryId,
      revision: current.revision,
      charged: chargedNum,
      agentPayment: agentNum,
      reason: reason.trim(),
      applyAgentOverride,
    };
    const requestKey = JSON.stringify(input);
    if (request.current?.key !== requestKey)
      request.current = { key: requestKey, id: newClientUuid() };
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await saveFeeAdjustment({ ...input, requestId: request.current.id });
      onCorrected();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!busy.current) onClose();
      }}
      title={riderOnly ? 'Change rider fee' : 'Adjust charges and rider pay'}
      subtitle={customerName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        {!riderOnly ? (
          <Banner tone="info">
            Set Reda&apos;s charge and rider pay separately. A rider amount you enter, including ₦0,
            is saved as the agreed pay for this delivery.
          </Banner>
        ) : null}
        {!ready && !error ? <ActivityIndicator /> : null}
        {ready ? (
          <>
            {riderOnly && missingClientCharge ? (
              <Text>
                This order has no client delivery charge recorded. Enter that charge below so the
                rider fee can be saved. Use 0 only if the client charge was waived too.
              </Text>
            ) : null}
            {!riderOnly || missingClientCharge ? (
              <Input
                label="Reda charge to client (₦)"
                accessibilityLabel="Reda charge to client"
                editable={!submitting}
                value={charged}
                onChange={(value) => {
                  setCharged(value);
                  setChargedEdited(true);
                }}
                keyboardType="numeric"
              />
            ) : null}
            <Input
              label="Rider pay for this delivery (₦)"
              accessibilityLabel="Rider pay for this delivery"
              editable={!submitting}
              value={agentPayment}
              onChange={(value) => {
                setAgentPayment(value);
                setAgentEdited(true);
              }}
              keyboardType="numeric"
            />
            <Text>
              {riderOnly
                ? 'Enter the agreed rider fee. Use 0 to waive it.'
                : 'Changing Reda’s charge does not change rider pay. Enter 0 in the fee you want to waive.'}
            </Text>
            {!valid ? (
              <Text>Enter non-negative amounts with at most two decimal places.</Text>
            ) : !current && !error ? (
              <ActivityIndicator />
            ) : null}
            {current ? (
              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: fonts.bold }}>Rider pay after saving</Text>
                {current.orders.map((order) => (
                  <View key={order.delivery_id} style={{ gap: 4 }}>
                    <Text>
                      {order.customer_name} · #{order.delivery_id.slice(0, 8)}
                      {order.delivery_id === deliveryId ? ' · this order' : ''}
                    </Text>
                    <Text>
                      {order.amount == null ? 'Needs attention' : formatNaira(order.amount)}
                      {order.manual
                        ? order.amount === 0
                          ? ' · manually waived'
                          : ' · manually set'
                        : ' · calculated automatically'}
                    </Text>
                    {order.reason ? (
                      <Text>
                        {PAY_ISSUE_TEXT[order.reason] ??
                          'Open the order to review its payment details.'}
                      </Text>
                    ) : null}
                  </View>
                ))}
                <Text style={{ fontFamily: fonts.bold }}>
                  Combined rider pay:{' '}
                  {current.total == null ? 'Needs attention' : formatNaira(current.total)}
                </Text>
                {current.pending ? (
                  <Banner tone="warn">
                    The adjustment can be saved. The issue shown above must also be resolved before
                    handover.
                  </Banner>
                ) : null}
                {current.settled ? (
                  <Banner tone="warn">
                    This rider&apos;s handover is already recorded. Review that handover before
                    changing these amounts.
                  </Banner>
                ) : null}
              </View>
            ) : null}
            <Input
              label="Reason"
              accessibilityLabel="Adjustment reason"
              editable={!submitting}
              maxLength={2000}
              value={reason}
              onChange={setReason}
              placeholder="e.g. Second delivery fee waived — charge once"
              multiline
            />
          </>
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
        {error ? (
          <Button variant="secondary" onPress={() => void refreshAmounts()}>
            Refresh amounts
          </Button>
        ) : null}
        <Button
          full
          disabled={
            submitting || !current || !valid || !reason.trim() || !changed || current.settled
          }
          onPress={() => void submit()}
        >
          {submitting ? 'Saving…' : riderOnly ? 'Save rider fee' : 'Save adjustment'}
        </Button>
      </View>
    </Sheet>
  );
}
