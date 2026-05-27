import { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useCurrentUser } from '@/hooks/useAuth';
import { createDelivery, previewDeliveryCharge, type ChargePreview } from '@/services/deliveries';
import { canSeeCharged } from '@/lib/permissions';
import { newClientUuid } from '@/lib/uuid';
import { formatNaira } from '@/lib/format';
import { AppBar, Banner, Button } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { DeliveryFieldsForm, type DeliveryFormState } from './DeliveryFieldsForm';

function todayLagos(): string {
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
}

export function NewDelivery() {
  const user = useCurrentUser();
  const showChargePreview = canSeeCharged(user.role);

  const [state, setState] = useState<DeliveryFormState | null>(null);
  const [isValid, setIsValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientUuidRef = useRef<string>(newClientUuid());

  const handleFormChange = useCallback((s: DeliveryFormState, v: boolean) => {
    setState(s);
    setIsValid(v);
  }, []);

  // Reda charge preview: mirror the server clamp so admin sees the cap kick in
  // before submit. Dispatchers don't see Charged (canSeeCharged is admin-only).
  const [chargePreview, setChargePreview] = useState<ChargePreview | null>(null);
  useEffect(() => {
    if (!showChargePreview || !state?.clientId || !state.locationId) {
      setChargePreview(null);
      return;
    }
    let cancelled = false;
    previewDeliveryCharge(state.locationId, state.clientId)
      .then((p) => {
        if (!cancelled) setChargePreview(p);
      })
      .catch(() => {
        if (!cancelled) setChargePreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showChargePreview, state?.clientId, state?.locationId]);

  async function handleSubmit() {
    setError(null);
    if (!state) return;
    if (!isValid) {
      setError('Fill in all the required fields');
      return;
    }
    if (state.scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(state.scheduledDate)) {
      setError('Scheduled date must be YYYY-MM-DD');
      return;
    }

    setSubmitting(true);
    try {
      await createDelivery({
        clientUuid: clientUuidRef.current,
        clientId: state.clientId!,
        productCatalogId: state.productCatalogId!,
        customerName: state.customerName.trim(),
        customerPhone: state.customerPhone.trim(),
        rawAddress: state.rawAddress.trim(),
        quantityOrdered: state.quantityOrdered!,
        customerPrice: state.customerPrice!,
        locationId: state.locationId,
        scheduledDate: state.scheduledDate || todayLagos(),
        assignedAgentId: state.assignedAgentId,
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.surface }}
    >
      <AppBar
        title="New delivery"
        subtitle="Manual creation"
        onBack={() => router.back()}
        helpTopic="new-delivery"
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <DeliveryFieldsForm initial={{ scheduledDate: todayLagos() }} onChange={handleFormChange} />

        {showChargePreview && chargePreview ? (
          chargePreview.was_clamped ? (
            <Banner tone="warn" icon="alert" title="Reda charge capped">
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 13,
                  color: colors.warningDark,
                  lineHeight: 19,
                }}
              >
                {formatNaira(chargePreview.effective_charged)} — clamped from rate card{' '}
                {formatNaira(chargePreview.rate_card_charged)} by this client&apos;s per-delivery
                cap.
              </Text>
            </Banner>
          ) : (
            <Banner tone="info" icon="check" title="Reda charge">
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 13,
                  color: colors.infoDark,
                  lineHeight: 19,
                }}
              >
                {formatNaira(chargePreview.effective_charged)} for this delivery (rate card for the
                selected location).
              </Text>
            </Banner>
          )
        ) : null}

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={() => router.back()} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="emphasis"
            full
            icon="check"
            onPress={handleSubmit}
            disabled={submitting || !isValid}
          >
            {submitting ? 'Creating…' : 'Create delivery'}
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
