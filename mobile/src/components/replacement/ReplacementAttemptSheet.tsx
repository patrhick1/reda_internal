import { useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, CalendarPicker, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { useCurrentUser } from '@/hooks/useAuth';
import { canSeeCharged } from '@/lib/permissions';
import { useEnqueueReplacementAttempt } from '@/queue/mutations';
import {
  ATTEMPT_OUTCOME_LABELS,
  type ReplacementAttemptOutcome,
} from '@/services/replacements';

function todayLagos(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function number(value: string): number {
  const parsed = Number(value.replace(/[,₦\s]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const STATUS_BY_OUTCOME: Record<ReplacementAttemptOutcome, string> = {
  customer_unreachable: 'not_answering',
  customer_postponed: 'postponed',
  details_incorrect: 'postponed',
  customer_rejected: 'failed_delivery',
  cancelled: 'cancelled',
  other: 'follow_up',
};

export function ReplacementAttemptSheet({
  open,
  deliveryId,
  customerName,
  onClose,
  onCommitted,
}: {
  open: boolean;
  deliveryId: string;
  customerName: string | null;
  onClose: () => void;
  onCommitted: (status: string, jobId: string) => void;
}) {
  const user = useCurrentUser();
  const canRecordClientCharge = canSeeCharged(user.role);
  const canRecordPay = user.role === 'admin' || user.role === 'dispatcher';
  const enqueue = useEnqueueReplacementAttempt();
  const [outcome, setOutcome] = useState<ReplacementAttemptOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [clientCharge, setClientCharge] = useState('0');
  const [agentPayment, setAgentPayment] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsDate = outcome === 'customer_postponed' || outcome === 'details_incorrect';

  function reset() {
    setOutcome(null);
    setNotes('');
    setNextDate('');
    setClientCharge('0');
    setAgentPayment('0');
    setError(null);
  }

  async function submit() {
    if (!outcome) {
      setError('Choose what happened.');
      return;
    }
    if ((outcome === 'details_incorrect' || outcome === 'other') && !notes.trim()) {
      setError('Add a note explaining what needs to be corrected.');
      return;
    }
    if (needsDate && (!nextDate || nextDate <= todayLagos())) {
      setError('Choose a future date for the next attempt.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const jobId = await enqueue(
        {
          deliveryId,
          outcome,
          notes: notes.trim() || null,
          nextAttemptDate: needsDate ? nextDate : null,
          clientCharge: canRecordClientCharge ? number(clientCharge) : 0,
          agentPayment: canRecordPay ? number(agentPayment) : 0,
        },
        `Replacement attempt · ${customerName ?? ''}`,
      );
      const status = STATUS_BY_OUTCOME[outcome];
      reset();
      onCommitted(status, jobId);
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
      title="Unsuccessful replacement attempt"
      subtitle={customerName ?? undefined}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>Cancel</Button>
          <Button full variant="emphasis" onPress={submit} disabled={submitting || !outcome}>
            {submitting ? 'Saving…' : 'Record attempt'}
          </Button>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="info" icon="history">
          This keeps the replacement open when another visit is needed and records why today did not
          succeed.
        </Banner>
        <Select
          label="What happened?"
          value={outcome}
          options={Object.entries(ATTEMPT_OUTCOME_LABELS).map(([value, label]) => ({
            value: value as ReplacementAttemptOutcome,
            label,
          }))}
          onChange={setOutcome}
          required
        />
        {needsDate ? (
          <View style={{ gap: 8 }}>
            <Text style={fieldLabel}>Next attempt date</Text>
            <CalendarPicker value={nextDate || null} onSelect={setNextDate} minExclusiveYmd={todayLagos()} />
          </View>
        ) : null}
        <Input
          label={outcome === 'details_incorrect' || outcome === 'other' ? 'What went wrong? (required)' : 'Notes'}
          value={notes}
          onChange={setNotes}
          multiline
          placeholder="Add enough detail for ops and the next rider"
        />
        {canRecordClientCharge || canRecordPay ? (
          <View style={{ gap: 12 }}>
            <Text style={fieldLabel}>Attempt fee (usually ₦0)</Text>
            {canRecordClientCharge ? (
              <Input label="Charge client (₦)" value={clientCharge} onChange={setClientCharge} keyboardType="numeric" />
            ) : null}
            {canRecordPay ? (
              <Input label="Pay rider (₦)" value={agentPayment} onChange={setAgentPayment} keyboardType="numeric" />
            ) : null}
          </View>
        ) : null}
        {error ? <Banner tone="error" icon="alert">{error}</Banner> : null}
      </View>
    </Sheet>
  );
}

const fieldLabel = { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary };
