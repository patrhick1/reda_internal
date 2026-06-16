import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  createDelivery,
  findSimilarOpenDeliveries,
  previewDeliveryCharge,
  type ChargePreview,
  type SimilarOpenDelivery,
} from '@/services/deliveries';
import { canSeeCharged } from '@/lib/permissions';
import { newClientUuid } from '@/lib/uuid';
import { formatNaira } from '@/lib/format';
import { AppBar, Banner, Button } from '@/components/ui';
import { colors, fonts, STATUS_META } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import {
  DeliveryFieldsForm,
  MissingFieldsBanner,
  missingFieldsMessage,
  type DeliveryFormState,
  type FormValidation,
} from './DeliveryFieldsForm';

function todayLagos(): string {
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
}

/** Lagos hour-of-day (0-23). Independent of the device's clock zone — we
 *  shift UTC by +1 directly. Used to surface the after-hours banner; the
 *  server is the authority that actually does the bump. */
function lagosHour(): number {
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.getUTCHours();
}

/** Cross-platform yes/no prompt. Resolves true when the admin confirms,
 *  false on cancel / dismiss. On web we fall back to window.confirm
 *  because RN's Alert.alert is a no-op there. */
function confirmAsync(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    const ok = typeof window !== 'undefined' ? window.confirm(`${title}\n\n${message}`) : false;
    return Promise.resolve(ok);
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function describeSimilar(rows: SimilarOpenDelivery[]): string {
  const lines = rows.slice(0, 3).map((r) => {
    const label = STATUS_META[r.current_status ?? '']?.label ?? r.current_status ?? 'pending';
    const addr = (r.raw_address ?? '').trim() || '(no address)';
    return `• ${label} — ${addr}`;
  });
  const tail = rows.length > 3 ? `\n• …and ${rows.length - 3} more` : '';
  return lines.join('\n') + tail;
}

export function NewDelivery() {
  const user = useCurrentUser();
  const showChargePreview = canSeeCharged(user.role);

  const [state, setState] = useState<DeliveryFormState | null>(null);
  const [validation, setValidation] = useState<FormValidation>({ isValid: false, missing: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientUuidRef = useRef<string>(newClientUuid());

  const handleFormChange = useCallback((s: DeliveryFormState, v: FormValidation) => {
    setState(s);
    setValidation(v);
  }, []);
  const isValid = validation.isValid;

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

  // Past-date detection drives a warning banner — Uzo backdating to yesterday
  // is the exact scenario that hid two deliveries from Damilola's today tab.
  // useMemo so the test runs once per relevant field change rather than every
  // render. Memoising on the parsed value (not the raw string) lets us tolerate
  // partially-typed input like "2026-" without flickering the banner.
  const today = todayLagos();
  const scheduledDateIsPast = useMemo(() => {
    const d = state?.scheduledDate ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    return d < today;
  }, [state?.scheduledDate, today]);

  // After-hours hint: if it's >= 22:00 Lagos and the picked date is today,
  // tell the user the server will bump it to tomorrow. Server is the
  // authority; this is purely a "no surprises" UI nudge. The hour is read
  // once at mount/state-change rather than ticking — close enough; the
  // banner doesn't drive behaviour.
  const afterHoursBumpComing = useMemo(() => {
    const d = state?.scheduledDate ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    return d === today && lagosHour() >= 22;
  }, [state?.scheduledDate, today]);

  async function handleSubmit() {
    setError(null);
    if (!state) return;
    if (!isValid) {
      setError(missingFieldsMessage(validation.missing));
      return;
    }
    if (state.scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(state.scheduledDate)) {
      setError('Scheduled date must be YYYY-MM-DD');
      return;
    }

    const finalScheduledDate = state.scheduledDate || todayLagos();

    // Pre-flight duplicate check. Only meaningful when we know the agent —
    // the server-side same-agent guard keys on assigned_agent_id, so an
    // unassigned row can't collide here. Errors are non-fatal: if the
    // lookup fails for any reason we proceed and let the server arbitrate.
    if (state.assignedAgentId && state.customerPhone && state.productCatalogId) {
      try {
        const similar = await findSimilarOpenDeliveries(
          state.assignedAgentId,
          state.customerPhone.trim(),
          state.productCatalogId,
          finalScheduledDate,
        );
        if (similar.length > 0) {
          const ok = await confirmAsync(
            'Possible duplicate',
            `This agent already has ${similar.length === 1 ? 'an open delivery' : `${similar.length} open deliveries`} ` +
              `for this customer + product on ${finalScheduledDate}:\n\n${describeSimilar(similar)}\n\n` +
              'Create another one anyway?',
            'Create anyway',
          );
          if (!ok) return;
        }
      } catch {
        // Best-effort. A failed pre-check shouldn't block legitimate
        // creation — the server-side sibling guard is still in the loop.
      }
    }

    setSubmitting(true);
    try {
      await createDelivery({
        clientUuid: clientUuidRef.current,
        clientId: state.clientId!,
        productCatalogId: state.productCatalogId!,
        customerName: state.customerName.trim(),
        customerPhone: state.customerPhone.trim(),
        customerPhoneAlt: state.customerPhoneAlt.trim() || null,
        rawAddress: state.rawAddress.trim(),
        quantityOrdered: state.quantityOrdered!,
        customerPrice: state.customerPrice!,
        locationId: state.locationId,
        scheduledDate: finalScheduledDate,
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

        {scheduledDateIsPast ? (
          <Banner tone="warn" icon="alert" title="Scheduled for a past date">
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.warningDark,
                lineHeight: 19,
              }}
            >
              {state?.scheduledDate} is before today ({today}). The assigned agent won&apos;t see
              this delivery on their Today tab. Change the date to today if this was a typo.
            </Text>
          </Banner>
        ) : null}

        {afterHoursBumpComing ? (
          <Banner tone="info" icon="calendar" title="After 10pm Lagos — will land tomorrow">
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.infoDark,
                lineHeight: 19,
              }}
            >
              It&apos;s past 10pm Lagos. New orders for today are automatically moved to the next
              working day so agents aren&apos;t sent out late. Pick tomorrow or a later date
              explicitly if you want to override this.
            </Text>
          </Banner>
        ) : null}

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

        {!isValid ? <MissingFieldsBanner missing={validation.missing} /> : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button variant="secondary" full onPress={() => router.back()} disabled={submitting}>
              Cancel
            </Button>
          </View>
          <View style={{ flex: 2 }}>
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
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
