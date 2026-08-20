import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, DateField, Input, Sheet } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { colors, fonts } from '@/lib/theme';
import { newClientUuid } from '@/lib/uuid';
import { recordClientPayout, setClientBalanceOpening } from '@/services/reconciliation';

function parseMoney(value: string): number {
  return Number(value.replace(/[₦,\s]/g, ''));
}

export function ClientBalanceOpeningSheet({
  open,
  clientId,
  clientName,
  defaultDate,
  existingBalance,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: string | null;
  clientName: string | null;
  defaultDate: string;
  existingBalance?: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [effectiveDate, setEffectiveDate] = useState(defaultDate);
  const [opening, setOpening] = useState('0');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setEffectiveDate(defaultDate);
    setOpening(String(existingBalance ?? 0));
    setNote('');
    setError(null);
    requestIdRef.current = newClientUuid();
  }, [open, defaultDate, existingBalance]);

  const amount = parseMoney(opening);
  const valid = opening.trim() !== '' && Number.isFinite(amount);

  async function submit() {
    if (!clientId || !valid || submitting) {
      if (!valid) setError('Enter a valid balance. Use a minus sign when the client owes Reda.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await setClientBalanceOpening({
        requestUuid: requestIdRef.current,
        clientId,
        effectiveDate,
        openingBalance: amount,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => !submitting && onClose()}
      title={existingBalance == null ? 'Start balance tracking' : 'Adjust opening balance'}
      subtitle={clientName ?? undefined}
      footer={
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
              disabled={!valid || submitting}
            >
              {submitting ? 'Saving…' : 'Start tracking'}
            </Button>
          </View>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="info" icon="wallet" title="Balance at the start of this date">
          Enter 0 if the books are clear. Enter a positive figure when Reda already owes the client,
          or a negative figure when the client owes Reda. Activity from this date onward is added
          automatically.
        </Banner>
        <DateField
          label="Effective date"
          value={effectiveDate}
          onChange={setEffectiveDate}
          disableSundays
        />
        <Input
          label="Opening balance (₦, signed)"
          value={opening}
          onChange={setOpening}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          placeholder="0 or -2000"
          helper="Positive = Reda owes client · Negative = client owes Reda"
        />
        <Input
          label="Cutover note (optional)"
          value={note}
          onChange={setNote}
          placeholder="e.g. Balance confirmed with client"
          multiline
          numberOfLines={2}
        />
        {error ? <Banner tone="error">{error}</Banner> : null}
      </View>
    </Sheet>
  );
}

export function ClientPayoutSheet({
  open,
  clientId,
  clientName,
  payoutDate,
  availableBalance,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: string | null;
  clientName: string | null;
  payoutDate: string;
  availableBalance: number;
  onClose: () => void;
  onSaved: (amount: number) => void;
}) {
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setAmountText(String(Math.max(0, availableBalance)));
    setNote('');
    setError(null);
    requestIdRef.current = newClientUuid();
  }, [open, availableBalance]);

  const amount = parseMoney(amountText);
  const valid =
    amountText.trim() !== '' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= availableBalance + 0.005;

  async function submit() {
    if (!clientId || !valid || submitting) {
      if (!valid) setError(`Enter an amount between ₦0 and ${formatNaira(availableBalance)}.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await recordClientPayout({
        clientUuid: requestIdRef.current,
        clientId,
        payoutDate,
        amount,
        note: note.trim() || null,
      });
      onSaved(amount);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => !submitting && onClose()}
      title="Record client payout"
      subtitle={`${clientName ?? 'Client'} · available ${formatNaira(availableBalance)}`}
      footer={
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
              disabled={!valid || submitting}
            >
              {submitting ? 'Recording…' : 'Confirm money sent'}
            </Button>
          </View>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="warn" icon="cash" title="Record only after the transfer succeeds">
          A partial amount is allowed. Anything left unpaid remains on the client&apos;s balance and
          will be included next time.
        </Banner>
        <View style={{ backgroundColor: colors.surface, borderRadius: 14, padding: 14, gap: 5 }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
            Current amount payable
          </Text>
          <Text style={{ fontFamily: fonts.extrabold, fontSize: 24, color: colors.success }}>
            {formatNaira(availableBalance)}
          </Text>
        </View>
        <Input
          label="Amount actually sent (₦)"
          value={amountText}
          onChange={setAmountText}
          keyboardType="numeric"
          autoCapitalize="none"
        />
        <Input
          label="Bank reference / note (optional)"
          value={note}
          onChange={setNote}
          placeholder="e.g. GTB transfer 14:32"
          autoCapitalize="none"
        />
        {error ? <Banner tone="error">{error}</Banner> : null}
      </View>
    </Sheet>
  );
}
