import { View } from 'react-native';
import { Input } from '@/components/ui';
import { Select } from '@/components/Select';

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
export function parseReplacementPayment(draft: ReplacementPaymentDraft) {
  const amount = Number(draft.amount.replace(/[,₦\s]/g, ''));
  if (
    !draft.amount.trim() ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 0.000001
  )
    throw new Error('Enter a valid customer payment with up to two decimal places.');
  if (amount > 0 && (!draft.method || !draft.recipient))
    throw new Error('Choose the payment method and who received the money.');
  return {
    customerPaid: amount,
    paymentMethod: amount > 0 ? draft.method : null,
    paymentReceivedBy: amount > 0 ? draft.recipient : null,
  };
}
export function ReplacementPaymentFields({
  value,
  onChange,
  riderOnly = false,
}: {
  value: ReplacementPaymentDraft;
  onChange: (value: ReplacementPaymentDraft) => void;
  riderOnly?: boolean;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Input
        label="Customer payment received (₦)"
        value={value.amount}
        onChange={(amount) =>
          onChange({ ...value, amount, recipient: riderOnly ? 'rider' : value.recipient })
        }
        keyboardType="decimal-pad"
      />
      {Number(value.amount.replace(/[,₦\s]/g, '')) > 0 ? (
        <>
          <Select
            label="Payment method"
            value={value.method}
            options={[
              { value: 'cash', label: 'Cash' },
              { value: 'transfer', label: 'Transfer' },
              { value: 'pos', label: 'POS' },
            ]}
            onChange={(method) => onChange({ ...value, method })}
            required
          />
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
        </>
      ) : null}
    </View>
  );
}
