import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import {
  updateReplacementAttemptFees,
  type ReplacementAttempt,
} from '@/services/replacements';

function amount(value: string): number {
  const parsed = Number(value.replace(/[,₦\s]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function ReplacementFeeSheet({
  attempt,
  onClose,
  onSaved,
}: {
  attempt: ReplacementAttempt | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [clientCharge, setClientCharge] = useState('0');
  const [agentPayment, setAgentPayment] = useState('0');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!attempt) return;
    setClientCharge(String(attempt.client_charge ?? 0));
    setAgentPayment(String(attempt.agent_payment ?? 0));
    setReason('');
    setError(null);
  }, [attempt]);

  async function submit() {
    if (!attempt) return;
    if (!reason.trim()) {
      setError('Add a reason for this financial correction.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateReplacementAttemptFees({
        attemptId: attempt.id,
        clientCharge: amount(clientCharge),
        agentPayment: amount(agentPayment),
        reason: reason.trim(),
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={!!attempt}
      onClose={submitting ? () => undefined : onClose}
      title="Correct replacement fee"
      subtitle="Admin only · settlement-protected"
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button full variant="emphasis" onPress={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save correction'}
          </Button>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 14 }}>
        <Banner tone="info" icon="history">
          Use this when a rider recorded the attempt before Reda decided whether to charge the
          client or pay an attempt fee. Settled dates must be voided first.
        </Banner>
        <Input
          label="Charge client (₦)"
          value={clientCharge}
          onChange={setClientCharge}
          keyboardType="numeric"
        />
        <Input
          label="Pay rider (₦)"
          value={agentPayment}
          onChange={setAgentPayment}
          keyboardType="numeric"
        />
        <Input
          label="Reason for correction"
          value={reason}
          onChange={setReason}
          multiline
          placeholder="e.g. Vendor approved failed-trip fee"
        />
        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}
      </View>
    </Sheet>
  );
}
