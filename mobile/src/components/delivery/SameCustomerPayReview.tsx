import { useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Banner, Button, Card, DateField, Input } from '@/components/ui';
import { useSameCustomerShadowPay } from '@/hooks/useSameCustomer';
import { formatDateLagos, isYmd, todayLagos } from '@/lib/date';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNaira } from '@/lib/format';
import { colors, fonts } from '@/lib/theme';
import { newClientUuid } from '@/lib/uuid';
import {
  clearSameCustomerManualFee,
  reviewSameCustomerCompletionDay,
  type SameCustomerShadowPay,
} from '@/services/same-customer';
import { SameCustomerManualPaySheet } from '@/components/sheets/SameCustomerManualPaySheet';
import { SameCustomerNormalFeeSheet } from '@/components/sheets/SameCustomerNormalFeeSheet';

const REVIEW_REASONS: Record<string, string> = {
  missing_occurrence: 'The completion request did not include the time it happened.',
  date_discrepancy: 'The reported completion and server receipt fall on different Lagos days.',
  clock_skew: 'The device reported a completion time ahead of the server clock.',
  rate_mismatch:
    'The fees still calculated automatically need a rate check. Use Adjust pay above to set an agreed amount or waive a fee.',
  manual_review:
    'The rider, customer or completion details changed after the manual adjustment. Confirm the agreed pay for the changed delivery.',
  settled_period_conflict:
    'This change affects a settled period. Review the frozen settlement before recalculating pay.',
};

/** Admin-only validation surface, mounted only when shadow review is enabled. */
export function SameCustomerPayReview({
  deliveryId,
  presentation = 'details',
}: {
  deliveryId: string;
  presentation?: 'alert' | 'details';
}) {
  const query = useSameCustomerShadowPay(deliveryId);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ revision: number; day: string } | null>(null);
  const [clearRevision, setClearRevision] = useState<number | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [normalFeeDraft, setNormalFeeDraft] = useState<SameCustomerShadowPay | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const pay = query.data;
  const live = !!pay && pay.mode !== 'shadow';
  const validDay = !!editing && isYmd(editing.day) && editing.day <= todayLagos();

  async function clearException() {
    if (clearRevision == null || !reason.trim() || busy) return;
    const input = { deliveryId, revision: clearRevision, reason: reason.trim() };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload) request.current = { payload, id: newClientUuid() };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await clearSameCustomerManualFee({ ...input, requestId: request.current.id });
      setClearRevision(null);
      setReason('');
      setNotice(
        live
          ? 'Exception removed. Rider earnings have been recalculated.'
          : 'Exception removed from the proposed calculation. Current payable amount is unchanged.',
      );
      await query.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing || !validDay || !reason.trim() || busy) return;
    const input = {
      deliveryId,
      revision: editing.revision,
      acceptedDay: editing.day,
      reason: reason.trim(),
    };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload) request.current = { payload, id: newClientUuid() };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await reviewSameCustomerCompletionDay({ ...input, requestId: request.current.id });
      setEditing(null);
      setReason('');
      setNotice(
        live
          ? 'Completion day reviewed. Rider earnings have been recalculated.'
          : 'Completion day reviewed. The proposed earnings have been recalculated.',
      );
      await query.refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (presentation === 'alert') {
    if (!pay?.active || pay.state !== 'pending') return null;
    return (
      <Banner tone="warn" title="Rider fee needs review">
        {REVIEW_REASONS[pay.review_reason ?? ''] ?? 'This earning needs review.'} Open the fee
        calculation in the payment details below.
      </Banner>
    );
  }
  if (!query.isPending && !query.error && !pay) return null;
  return (
    <View style={{ marginTop: 12, gap: 8 }}>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !!editing || clearRevision != null || !!normalFeeDraft || groupOpen}
        onPress={() => setExpanded(!expanded)}
      >
        {expanded ? 'Hide fee calculation' : 'View fee calculation'}
      </Button>
      {expanded ? (
        <Card style={{ padding: 16, gap: 12 }}>
          <Text style={{ fontFamily: fonts.bold, color: colors.black }}>Fee calculation</Text>
          <Banner tone="info">
            {live
              ? 'These are actual rider earnings. Reviews can change payable amounts in open periods.'
              : 'Preview calculation. Current rider pay and settlements are unchanged.'}
          </Banner>
          {query.isPending ? <ActivityIndicator color={colors.black} /> : null}
          {query.error ? <Banner tone="error">{errorMessage(query.error)}</Banner> : null}
          {error ? <Banner tone="error">{error}</Banner> : null}
          {notice ? <Banner tone="info">{notice}</Banner> : null}
          {pay ? (
            <View style={{ gap: 8 }}>
              <Text style={{ fontFamily: fonts.medium }}>Successful rider: {pay.rider_name}</Text>
              <Text>
                Current payable:{' '}
                {pay.current_payable_amount == null
                  ? live && pay.state === 'pending'
                    ? 'Pending review'
                    : 'Not set'
                  : formatNaira(pay.current_payable_amount)}
              </Text>
              <Text>
                Automatic base rate:{' '}
                {pay.normal_fee == null ? 'Not set' : formatNaira(pay.normal_fee)}
              </Text>
              {pay.last_normal_fee_review ? (
                <Text style={{ color: colors.textSecondary }}>
                  Normal fee reviewed by {pay.last_normal_fee_review.reviewed_by}:{' '}
                  {pay.last_normal_fee_review.reason}
                </Text>
              ) : null}
              {pay.active && !editing && clearRevision == null ? (
                <Button variant="secondary" disabled={busy} onPress={() => setNormalFeeDraft(pay)}>
                  Correct automatic base rate
                </Button>
              ) : null}
              <Text style={{ fontFamily: fonts.semibold }}>
                {live ? 'Rider earning: ' : 'Proposed earning: '}
                {pay.state === 'ready' && pay.expected_amount != null
                  ? `${formatNaira(pay.expected_amount)} (${pay.manual_amount != null ? 'manual exception' : pay.mode === 'legacy' ? 'normal fee' : pay.multiplier === 1 ? 'full fee' : 'half fee'})`
                  : pay.state === 'reversed'
                    ? 'Reversed'
                    : 'Pending review'}
              </Text>
              {pay.review_reason ? (
                <Banner tone="info">
                  {REVIEW_REASONS[pay.review_reason] ?? 'This earning needs review.'}
                </Banner>
              ) : null}
              {pay.manual_amount != null ? (
                <Text>
                  {pay.manual_amount === 0 ? 'Manually waived' : 'Manually set'}:{' '}
                  {formatNaira(pay.manual_amount)} · {pay.manual_reason}
                </Text>
              ) : null}
              {pay.group_id && pay.review_reason === 'manual_review' ? (
                <Button variant="secondary" disabled={busy} onPress={() => setGroupOpen(true)}>
                  Review group amounts
                </Button>
              ) : null}
              {pay.active && pay.manual_amount != null && clearRevision == null && !editing ? (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setClearRevision(pay.revision);
                    setReason('');
                    setError(null);
                    setNotice(null);
                  }}
                >
                  {live ? 'Remove manual exception' : 'Remove exception from preview'}
                </Button>
              ) : null}
              <Text>
                Completion day (Lagos):{' '}
                {pay.business_date ? formatDateLagos(pay.business_date) : 'Needs confirmation'}
              </Text>
              <Text>
                Reported time:{' '}
                {pay.reported_occurred_at
                  ? formatDateTime(pay.reported_occurred_at)
                  : 'Not supplied'}
              </Text>
              <Text>Received: {formatDateTime(pay.recorded_at)}</Text>
              <Text>Accounting date: {formatDateLagos(pay.accounting_date)}</Text>
              {pay.last_date_review ? (
                <Text style={{ color: colors.textSecondary }}>
                  Reviewed by {pay.last_date_review.reviewed_by}: {pay.last_date_review.reason}
                </Text>
              ) : null}
              {pay.active && !editing && clearRevision == null ? (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setEditing({ revision: pay.revision, day: pay.business_date ?? '' });
                    setReason('');
                    setError(null);
                    setNotice(null);
                  }}
                >
                  Review completion day
                </Button>
              ) : null}
            </View>
          ) : null}
          {editing ? (
            <View style={{ gap: 12 }}>
              <Text>
                Confirm the day the delivery actually happened in Lagos, using the available
                evidence.
              </Text>
              <DateField
                label="Actual completion day (Lagos)"
                value={editing.day}
                onChange={(day) => {
                  if (!busy) setEditing({ ...editing, day });
                }}
              />
              {editing.day && !validDay ? (
                <Banner tone="error">Choose a valid date no later than today in Lagos.</Banner>
              ) : null}
              <Input
                label="Reason and evidence"
                value={reason}
                multiline
                maxLength={2000}
                onChange={(value) => {
                  if (!busy) setReason(value);
                }}
              />
              <Button disabled={busy || !validDay || !reason.trim()} onPress={() => void save()}>
                {busy ? 'Saving…' : 'Save reviewed day'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  setEditing(null);
                  setError(null);
                  void query.refetch();
                }}
              >
                Cancel and refresh
              </Button>
            </View>
          ) : null}
          {clearRevision != null ? (
            <View style={{ gap: 12 }}>
              <Banner tone="info">
                {live
                  ? 'Removing this exception recalculates actual rider earnings using the applicable pay rule. Affected open group amounts may change.'
                  : 'The fixed full-and-half rule will replace this exception in the proposed calculation. Current payable amounts stay unchanged.'}
              </Banner>
              <Input
                label="Reason for removing exception"
                value={reason}
                multiline
                maxLength={2000}
                onChange={(value) => {
                  if (!busy) setReason(value);
                }}
              />
              <Button disabled={busy || !reason.trim()} onPress={() => void clearException()}>
                {busy ? 'Saving…' : live ? 'Remove manual exception' : 'Remove preview exception'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  setClearRevision(null);
                  setError(null);
                  void query.refetch();
                }}
              >
                Cancel and refresh
              </Button>
            </View>
          ) : null}
          {normalFeeDraft ? (
            <SameCustomerNormalFeeSheet
              pay={normalFeeDraft}
              onClose={() => {
                setNormalFeeDraft(null);
                void query.refetch();
              }}
              onSaved={() => {
                setNormalFeeDraft(null);
                setNotice('Normal fee corrected. Group earnings recalculated.');
                void query.refetch();
              }}
            />
          ) : null}
          {groupOpen && pay?.group_id ? (
            <SameCustomerManualPaySheet
              key={pay.group_id}
              groupId={pay.group_id}
              onClose={() => setGroupOpen(false)}
              onReviewed={() => {
                setGroupOpen(false);
                setNotice('Group amounts reviewed.');
                void query.refetch();
              }}
            />
          ) : null}
          {query.error ? (
            <Button variant="secondary" onPress={() => void query.refetch()}>
              Retry
            </Button>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}
