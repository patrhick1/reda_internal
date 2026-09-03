import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatDateTime } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { addCustomerBlacklist, type AddBlacklistResult } from '@/services/blacklist';

/** Add a customer's number to the blacklist. Used from Catalog › Blacklist
 *  (blank number) and from a delivery's detail (number prefilled, delivery
 *  linked as evidence). Calls add_customer_blacklist directly — managers are
 *  at a desk, so an inline error beats a queued one. After success the sheet
 *  shows the receipt (including how many open orders still carry the number)
 *  and the parent is told on Done. */
export function BlacklistNumberSheet({
  open,
  initialPhone,
  customerName,
  sourceDeliveryId,
  onClose,
  onAdded,
}: {
  open: boolean;
  initialPhone?: string;
  customerName?: string;
  sourceDeliveryId?: string | null;
  onClose: () => void;
  onAdded: (result: AddBlacklistResult) => void;
}) {
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddBlacklistResult | null>(null);

  // Re-seed the number each time the sheet opens: the delivery detail hands in
  // whichever order the user is looking at.
  useEffect(() => {
    if (open) {
      setPhone(initialPhone ?? '');
      setReason('');
      setError(null);
      setResult(null);
    }
  }, [open, initialPhone]);

  async function submit() {
    if (!phone.trim()) {
      setError('Enter the phone number');
      return;
    }
    if (!reason.trim()) {
      setError('A reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await addCustomerBlacklist({
        phone: phone.trim(),
        reason: reason.trim(),
        sourceDeliveryId: sourceDeliveryId ?? null,
      });
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (submitting) return;
        if (result) onAdded(result);
        else onClose();
      }}
      title={result ? 'Number blacklisted' : 'Blacklist this number'}
      subtitle={customerName}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        {result ? (
          <>
            <Banner tone={result.already_listed ? 'info' : 'ok'} icon="phoneOff">
              {result.already_listed
                ? `${result.phone_display} was already on the blacklist (since ${formatDateTime(result.added_at)}): ${result.reason}`
                : `${result.phone_display} is now blacklisted. Orders from it will be refused, from the bot and from the app.`}
            </Banner>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              {result.open_orders === 0
                ? 'No open orders currently carry this number.'
                : `${result.open_orders} open ${result.open_orders === 1 ? 'order' : 'orders'} still ${result.open_orders === 1 ? 'carries' : 'carry'} this number. They are not closed automatically — close them as Unserious from the deliveries list if they should not go out.`}
            </Text>
            <Button variant="primary" full onPress={() => onAdded(result)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Banner tone="warn" icon="alert">
              Orders from this number will be refused from now on — from the WhatsApp bot and from
              the app. Any format works (+234…, 0…, bare digits). Open orders already in the app are
              not closed.
            </Banner>

            <Input
              label="Phone number"
              value={phone}
              onChange={setPhone}
              icon="phone"
              keyboardType="phone-pad"
              autoCapitalize="none"
              placeholder="0803 000 0000"
            />

            <Input
              label="Reason (required)"
              value={reason}
              onChange={setReason}
              placeholder="e.g. places orders across vendors, never receives"
              autoCapitalize="sentences"
              multiline
              numberOfLines={3}
            />

            {error ? (
              <Banner tone="error" icon="alert">
                {error}
              </Banner>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Button variant="secondary" onPress={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="emphasis"
                icon="phoneOff"
                onPress={submit}
                disabled={submitting}
                style={{ flex: 1 }}
              >
                {submitting ? 'Blacklisting…' : 'Blacklist number'}
              </Button>
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}
