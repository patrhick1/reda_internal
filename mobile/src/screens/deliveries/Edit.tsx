import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { useEditLock } from '@/hooks/useEditLock';
import {
  getDelivery,
  updateDeliveryFields,
  type UpdateDeliveryFieldsPatch,
} from '@/services/deliveries';
import { canEditDelivery } from '@/lib/permissions';
import { AppBar, Banner, Button, Card, Empty } from '@/components/ui';
import {
  DeliveryFieldsForm,
  MissingFieldsBanner,
  type DeliveryFormState,
  type FormValidation,
} from './DeliveryFieldsForm';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export default function EditDeliveryScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const deliveryQ = useAsync(() => getDelivery(user.role, id), [user.role, id]);

  // Only claim an edit lock once we've confirmed the delivery is actually
  // editable. Acquiring on, say, a delivered delivery wastes an RPC and
  // creates a brief `edit_locks` row before the screen pivots to the
  // "Can't edit" empty state.
  const lockableId =
    id && deliveryQ.data && canEditDelivery(user.role, deliveryQ.data.current_status) ? id : null;
  const lock = useEditLock('delivery', lockableId);

  const [state, setState] = useState<DeliveryFormState | null>(null);
  const [validation, setValidation] = useState<FormValidation>({ isValid: false, missing: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFormChange = useCallback((s: DeliveryFormState, v: FormValidation) => {
    setState(s);
    setValidation(v);
  }, []);
  const isValid = validation.isValid;

  const initial = useMemo<Partial<DeliveryFormState>>(() => {
    const d = deliveryQ.data;
    if (!d) return {};
    return {
      clientId: d.client_id ?? null,
      productCatalogId: d.product_catalog_id ?? null,
      customerName: d.customer_name ?? '',
      customerPhone: d.customer_phone ?? '',
      rawAddress: d.raw_address ?? '',
      locationId: d.location_id ?? null,
      assignedAgentId: d.assigned_agent_id ?? null,
      quantityOrdered: d.quantity_ordered ?? null,
      customerPrice: d.customer_price ?? null,
      scheduledDate: d.scheduled_date ?? '',
    };
  }, [deliveryQ.data]);

  // -------------------------------------------------------- early states

  if (deliveryQ.loading && !deliveryQ.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </View>
    );
  }
  if (deliveryQ.error || !deliveryQ.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <Empty icon="alert" title="Not found" sub={deliveryQ.error ?? 'Delivery not available.'} />
      </View>
    );
  }

  const d = deliveryQ.data;
  if (!canEditDelivery(user.role, d.current_status)) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <Empty
          icon="lock"
          title="Can't edit this delivery"
          sub={`This delivery is "${d.current_status}". Only pre-delivery rows can be edited.`}
        />
      </View>
    );
  }

  // -------------------------------------------------------- lock states

  if (lock.state.kind === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </View>
    );
  }
  if (lock.state.kind === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <Empty icon="alert" title="Could not lock this delivery" sub={lock.state.message} />
      </View>
    );
  }
  if (lock.state.kind === 'held_by_other') {
    const ls = lock.state;
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Edit delivery" onBack={() => router.back()} />
        <View style={{ padding: 16, gap: 12 }}>
          <Card>
            <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black }}>
              {ls.holderName} is editing this
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.textSecondary,
                marginTop: 6,
              }}
            >
              They started {minutesAgo(ls.acquiredAt)} min ago. They might still be on it — opening
              it now means anything they had unsaved will be lost.
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

  // -------------------------------------------------------- held: edit form

  async function handleSave() {
    setError(null);
    if (!state) return;
    if (!isValid) {
      setError('Fill in the required fields');
      return;
    }
    const patch: UpdateDeliveryFieldsPatch = {};
    if (state.customerName.trim() !== (d.customer_name ?? ''))
      patch.customerName = state.customerName.trim();
    if (state.customerPhone.trim() !== (d.customer_phone ?? ''))
      patch.customerPhone = state.customerPhone.trim();
    if (state.rawAddress.trim() !== (d.raw_address ?? ''))
      patch.rawAddress = state.rawAddress.trim();
    if (state.locationId !== (d.location_id ?? null)) patch.locationId = state.locationId;
    if (state.clientId !== (d.client_id ?? null)) patch.clientId = state.clientId ?? undefined;
    if (state.productCatalogId !== (d.product_catalog_id ?? null))
      patch.productCatalogId = state.productCatalogId ?? undefined;
    if (state.quantityOrdered !== (d.quantity_ordered ?? null))
      patch.quantityOrdered = state.quantityOrdered ?? undefined;
    if (state.customerPrice !== (d.customer_price ?? null))
      patch.customerPrice = state.customerPrice ?? undefined;
    if (state.assignedAgentId !== (d.assigned_agent_id ?? null))
      patch.assignedAgentId = state.assignedAgentId;

    if (Object.keys(patch).length === 0) {
      // Nothing changed; treat as cancel.
      router.back();
      return;
    }

    setSubmitting(true);
    try {
      await updateDeliveryFields(d.id!, patch);
      await lock.release().catch(() => {
        /* swallow */
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
        title="Edit delivery"
        subtitle={d.customer_name ?? undefined}
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 140 + insets.bottom, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <DeliveryFieldsForm initial={initial} onChange={handleFormChange} />
        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}
        {!isValid ? <MissingFieldsBanner missing={validation.missing} /> : null}
      </ScrollView>

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
          <Button variant="secondary" full onPress={() => router.back()} disabled={submitting}>
            Cancel
          </Button>
        </View>
        <View style={{ flex: 2 }}>
          <Button
            variant="emphasis"
            full
            icon="check"
            onPress={handleSave}
            disabled={!isValid || submitting}
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
