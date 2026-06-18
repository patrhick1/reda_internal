import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { useEditLock } from '@/hooks/useEditLock';
import { getBotInbound, discardInbound, resolveInboundToDelivery } from '@/services/bot';
import { createDelivery } from '@/services/deliveries';
import { canResolveReview } from '@/lib/permissions';
import { newClientUuid } from '@/lib/uuid';
import { AppBar, Banner, Button, Card, Empty, Sheet } from '@/components/ui';
import {
  DeliveryFieldsForm,
  MissingFieldsBanner,
  type DeliveryFormState,
  type FormValidation,
} from '@/screens/deliveries/DeliveryFieldsForm';
import { colors, fonts } from '@/lib/theme';
import { formatDateTime } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import {
  reviewReason,
  splitPhone,
  primaryProduct,
  primaryPrice,
  type ParseResultShape,
} from './reviewReason';

const DISCARD_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'not a real order', label: 'Not a real order' },
  { value: 'other', label: 'Other' },
] as const;

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function todayLagos(): string {
  return new Date(new Date().getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function InboundDetailScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const allowed = canResolveReview(user.role);

  const inboundQ = useAsync(
    () => (allowed && id ? getBotInbound(id) : Promise.resolve(null)),
    [allowed, id],
  );
  const lock = useEditLock('bot_inbound', allowed ? (id ?? null) : null);

  const row = inboundQ.data;
  const parse = (row?.parse_result ?? {}) as ParseResultShape;
  const extracted = parse.extracted ?? {};
  const phoneSplit = useMemo(
    () => splitPhone(extracted.customer_phone ?? null),
    [extracted.customer_phone],
  );
  // [Feature A] the bot now writes a multi-product shape (product_matches[] /
  // extracted.products[] / total_amount); the old singular product/quantity/
  // customer_price keys are gone for new rows. Read the first line via the shared
  // helper (legacy fallback inside) so client/product/qty/price aren't blank.
  const primary = useMemo(() => primaryProduct(parse), [parse]);

  const initial = useMemo<Partial<DeliveryFormState>>(
    () => ({
      clientId: primary.clientId,
      productCatalogId: primary.productCatalogId,
      customerName: extracted.customer_name ?? '',
      customerPhone: phoneSplit.primary,
      // A parsed "0803… or 0815…" now persists: primary + alternate both land.
      customerPhoneAlt: phoneSplit.alternate ?? '',
      rawAddress: extracted.raw_address ?? '',
      locationId: parse.address?.matched_location_id ?? null,
      assignedAgentId: parse.agent_resolution?.agent_id ?? null,
      quantityOrdered: primary.quantity,
      customerPrice: primaryPrice(parse),
      scheduledDate: todayLagos(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row?.id],
  );

  const [state, setState] = useState<DeliveryFormState | null>(null);
  const [validation, setValidation] = useState<FormValidation>({ isValid: false, missing: [] });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const clientUuidRef = useRef<string>(newClientUuid());

  const handleFormChange = useCallback((s: DeliveryFormState, v: FormValidation) => {
    setState(s);
    setValidation(v);
  }, []);
  const isValid = validation.isValid;

  // ---- early-return states ------------------------------------------------

  if (!allowed) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <Empty
          icon="alert"
          title="Not allowed"
          sub="Only admins and dispatchers can fix review items."
        />
      </View>
    );
  }

  if (inboundQ.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </View>
    );
  }
  if (inboundQ.error || !row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <Empty
          icon="alert"
          title="Not found"
          sub={inboundQ.error || 'This review item is not available.'}
        />
      </View>
    );
  }
  if (row.status !== 'needs_review') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <Empty
          icon="check"
          title="Already handled"
          sub={`This review item is in status "${row.status}". Open the Deliveries tab to find the resulting delivery.`}
        />
      </View>
    );
  }

  // ---- lock states --------------------------------------------------------

  if (lock.state.kind === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </View>
    );
  }
  if (lock.state.kind === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <Empty icon="alert" title="Could not lock this item" sub={lock.state.message} />
      </View>
    );
  }
  if (lock.state.kind === 'held_by_other') {
    const lockState = lock.state;
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Fix review" onBack={() => router.back()} />
        <View style={{ padding: 16, gap: 12 }}>
          <Card>
            <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black }}>
              {lockState.holderName} is fixing this
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.textSecondary,
                marginTop: 6,
              }}
            >
              They started {minutesAgo(lockState.acquiredAt)} min ago. They might still be on it —
              opening it now means anything they had unsaved will be lost.
            </Text>
          </Card>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button variant="secondary" onPress={() => router.back()}>
              Back
            </Button>
            <Button
              variant="emphasis"
              full
              icon="lock"
              onPress={() => {
                void lock.takeOver();
              }}
            >
              Take over
            </Button>
          </View>
        </View>
      </View>
    );
  }

  // ---- held: render the form ---------------------------------------------

  async function handleCreate() {
    setError(null);
    if (!state) return;
    if (!isValid) {
      setError('Fill in the required fields');
      return;
    }
    setSubmitting(true);
    try {
      const newId = await createDelivery({
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
      await resolveInboundToDelivery(row!.id, newId);
      // Server also drops the lock; release defensively in case of net hiccup.
      await lock.release().catch(() => {
        /* swallow */
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function handleDiscard(reason: string) {
    setError(null);
    setDiscarding(true);
    try {
      await discardInbound(row!.id, reason);
      await lock.release().catch(() => {
        /* swallow */
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setDiscarding(false);
      setDiscardOpen(false);
    }
  }

  const rawText = row.raw_text ?? '';
  const truncated = rawText.length > 220;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.surface }}
    >
      <AppBar
        title="Fix review"
        subtitle={`Received ${formatDateTime(row.received_at)}`}
        onBack={() => router.back()}
        helpTopic="review"
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 140 + insets.bottom, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Why it's in review */}
        <Banner tone="warn" icon="alert" title="Why this needs review">
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.warningDark,
              lineHeight: 19,
            }}
          >
            {reviewReason(row)}
          </Text>
        </Banner>

        {/* Original WhatsApp text */}
        {rawText ? (
          <Card>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 11,
                color: colors.textSecondary,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
              }}
            >
              Original message
            </Text>
            <Text
              style={{
                fontFamily: fonts.regular,
                fontSize: 13,
                color: colors.textPrimary,
                marginTop: 8,
                lineHeight: 19,
              }}
            >
              {showFullText || !truncated ? rawText : rawText.slice(0, 220) + '…'}
            </Text>
            {truncated ? (
              <Pressable onPress={() => setShowFullText((v) => !v)}>
                <Text
                  style={{
                    fontFamily: fonts.semibold,
                    fontSize: 12,
                    color: colors.red,
                    marginTop: 8,
                  }}
                >
                  {showFullText ? 'Show less' : 'Show full message'}
                </Text>
              </Pressable>
            ) : null}
          </Card>
        ) : null}

        {/* Multi-line order: the fix form is single-product, so warn before it
            silently drops the extra lines (rare — most review rows are 1 line). */}
        {primary.lineCount > 1 ? (
          <Banner tone="warn" icon="alert">
            {`This order has ${primary.lineCount} product lines. This screen creates a single-product delivery — only the first line is used. Create it, then add the other items by editing the delivery.`}
          </Banner>
        ) : null}

        {/* The form, pre-filled from parse_result */}
        <DeliveryFieldsForm
          initial={initial}
          hideFields={['scheduledDate']}
          productCandidates={primary.candidates.length ? primary.candidates : null}
          onChange={handleFormChange}
        />

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}
        {!isValid ? <MissingFieldsBanner missing={validation.missing} /> : null}
      </ScrollView>

      {/* Footer buttons */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 16 + insets.bottom,
          backgroundColor: colors.white,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          flexDirection: 'row',
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            full
            icon="x"
            onPress={() => setDiscardOpen(true)}
            disabled={submitting || discarding}
          >
            Discard
          </Button>
        </View>
        <View style={{ flex: 2 }}>
          <Button
            variant="emphasis"
            full
            icon="check"
            onPress={handleCreate}
            disabled={!isValid || submitting || discarding}
          >
            {submitting ? 'Creating…' : 'Create delivery'}
          </Button>
        </View>
      </View>

      {/* Discard reason sheet */}
      <Sheet
        open={discardOpen}
        onClose={() => !discarding && setDiscardOpen(false)}
        title="Discard this message?"
        subtitle="Move it out of Needs Review with a reason."
      >
        <View style={{ gap: 8 }}>
          {DISCARD_REASONS.map((r) => (
            <Pressable
              key={r.value}
              onPress={() => {
                void handleDiscard(r.value);
              }}
              disabled={discarding}
              style={({ pressed }) => ({
                padding: 14,
                borderRadius: 12,
                borderWidth: 1.5,
                borderColor: colors.border,
                backgroundColor: pressed ? colors.surface : colors.white,
              })}
            >
              <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>
                {r.label}
              </Text>
            </Pressable>
          ))}
          {discarding ? (
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : null}
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
