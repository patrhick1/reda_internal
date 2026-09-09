import { View } from 'react-native';
import { Banner, Input } from '@/components/ui';
import { Select } from '@/components/Select';

/** Same vocabulary as marking a delivery. "Cash" covers cash and the rider's
 *  POS — Reda's ₦500 POS fee comes off the client's remit, exactly as on a
 *  cash delivery. "To vendor" means the customer paid the vendor directly, so
 *  nothing reached Reda and the amount must be 0. The server enforces all of
 *  this too (`_validate_replacement_payment`). */
export const REPLACEMENT_CASH_POS_FEE = 500;

export type ReplacementPaymentDraft = {
  amount: string;
  method: string | null;
  recipient: string | null;
};

export const emptyReplacementPayment = (): ReplacementPaymentDraft => ({
  amount: '0',
  method: null,
  recipient: null,
});

function amountOf(draft: ReplacementPaymentDraft): number {
  return Number(draft.amount.replace(/[,₦\s]/g, ''));
}

export function parseReplacementPayment(draft: ReplacementPaymentDraft) {
  const amount = amountOf(draft);
  if (
    !draft.amount.trim() ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 0.000001
  )
    throw new Error('Enter a valid customer payment with up to two decimal places.');
  if (draft.method === 'vendor_direct') {
    if (amount > 0)
      throw new Error(
        '"To vendor" means the customer paid the vendor directly — set the amount to 0.',
      );
    return { customerPaid: 0, paymentMethod: 'vendor_direct', paymentReceivedBy: null };
  }
  if (amount > 0) {
    if (draft.method !== 'cash' && draft.method !== 'transfer')
      throw new Error('Choose how the customer paid: cash or transfer.');
    if (draft.recipient !== 'rider' && draft.recipient !== 'reda')
      throw new Error('Say who received the money: the rider or REDA directly.');
    return {
      customerPaid: amount,
      paymentMethod: draft.method,
      paymentReceivedBy: draft.recipient,
    };
  }
  return { customerPaid: 0, paymentMethod: null, paymentReceivedBy: null };
}

export function ReplacementPaymentFields({
  value,
  onChange,
  riderOnly = false,
}: {
  value: ReplacementPaymentDraft;
  onChange: (value: ReplacementPaymentDraft) => void;
  /** Riders can only record money they received themselves, and never see the
   *  POS-fee note (the fee is the client's, not theirs). */
  riderOnly?: boolean;
}) {
  const amount = amountOf(value);
  const toVendor = value.method === 'vendor_direct';
  return (
    <View style={{ gap: 12 }}>
      <Input
        label="Customer payment received (₦)"
        value={toVendor ? '0' : value.amount}
        onChange={(next) =>
          onChange({
            ...value,
            amount: next,
            // Typing an amount contradicts "to vendor" — clear it so the method
            // has to be chosen again, and pin the recipient for riders.
            method: toVendor ? null : value.method,
            recipient: riderOnly ? 'rider' : value.recipient,
          })
        }
        keyboardType="decimal-pad"
        editable={!toVendor}
      />
      <Select
        label="Payment method"
        value={value.method}
        options={[
          { value: 'cash', label: 'Cash' },
          { value: 'transfer', label: 'Transfer' },
          { value: 'vendor_direct', label: 'To vendor' },
        ]}
        onChange={(method) =>
          onChange(
            method === 'vendor_direct'
              ? { amount: '0', method, recipient: null }
              : { ...value, method, recipient: riderOnly ? 'rider' : value.recipient },
          )
        }
        required
      />
      {toVendor ? (
        <Banner tone="info" icon="user">
          The customer paid the vendor directly, so no money reached Reda. The client still owes the
          replacement fee.
        </Banner>
      ) : null}
      {amount > 0 && !toVendor ? (
        <Select
          label="Money received by"
          value={riderOnly ? 'rider' : value.recipient}
          options={
            riderOnly
              ? [{ value: 'rider', label: 'Me (rider)' }]
              : [
                  { value: 'rider', label: 'Rider' },
                  { value: 'reda', label: 'REDA directly' },
                ]
          }
          onChange={(recipient) => onChange({ ...value, recipient })}
          required
        />
      ) : null}
      {amount > 0 && value.method === 'cash' && !riderOnly ? (
        <Banner tone="info" icon="cash" title="POS fee on cash">
          {`Reda's ₦${REPLACEMENT_CASH_POS_FEE} POS fee comes off the client's remit for this replacement, the same as on a cash delivery.`}
        </Banner>
      ) : null}
    </View>
  );
}
