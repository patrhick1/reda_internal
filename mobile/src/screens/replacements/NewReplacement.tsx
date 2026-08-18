import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { AppBar, Banner, Button, Card, Input, Icon } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { newClientUuid } from '@/lib/uuid';
import { listActiveProductsByClient, type Product } from '@/services/products';
import {
  createReplacement,
  REPLACEMENT_REASON_LABELS,
  RETURN_INSTRUCTION_LABELS,
  type ReplacementReason,
  type ReturnInstruction,
} from '@/services/replacements';
import {
  DeliveryFieldsForm,
  MissingFieldsBanner,
  completeLines,
  type DeliveryFormState,
  type FormValidation,
} from '@/screens/deliveries/DeliveryFieldsForm';
import { useCurrentUser } from '@/hooks/useAuth';
import { canSeeCharged } from '@/lib/permissions';

type ReturnLine = {
  id: number;
  productCatalogId: string | null;
  quantity: string;
  vendorInstruction: ReturnInstruction;
};

function todayLagos(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function amount(value: string): number {
  const parsed = Number(value.replace(/[,₦\s]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function NewReplacement({ basePath }: { basePath: '/(admin)' | '/(dispatcher)' }) {
  const user = useCurrentUser();
  const showClientCharge = canSeeCharged(user.role);
  const clientUuid = useRef(newClientUuid());
  const nextReturnId = useRef(2);
  const [form, setForm] = useState<DeliveryFormState | null>(null);
  const [formValidation, setFormValidation] = useState<FormValidation>({
    isValid: false,
    missing: [],
  });
  const [reason, setReason] = useState<ReplacementReason | null>(null);
  const [notes, setNotes] = useState('');
  const [clientCharge, setClientCharge] = useState('0');
  const [agentPayment, setAgentPayment] = useState('0');
  const [returns, setReturns] = useState<ReturnLine[]>([
    {
      id: 1,
      productCatalogId: null,
      quantity: '1',
      vendorInstruction: 'ask_if_damaged',
    },
  ]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFormChange = useCallback((state: DeliveryFormState, validation: FormValidation) => {
    setForm(state);
    setFormValidation(validation);
  }, []);

  useEffect(() => {
    if (!form?.clientId) {
      setProducts([]);
      setReturns((lines) => lines.map((line) => ({ ...line, productCatalogId: null })));
      return;
    }
    let cancelled = false;
    setLoadingProducts(true);
    listActiveProductsByClient(form.clientId)
      .then((rows) => {
        if (cancelled) return;
        setProducts(rows);
        const validIds = new Set(rows.map((row) => row.id));
        setReturns((lines) =>
          lines.map((line) =>
            line.productCatalogId && !validIds.has(line.productCatalogId)
              ? { ...line, productCatalogId: null }
              : line,
          ),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form?.clientId]);

  const productOptions = useMemo(
    () => products.map((product) => ({ value: product.id, label: product.product_name })),
    [products],
  );
  const returnProductIds = returns
    .map((line) => line.productCatalogId)
    .filter((id): id is string => !!id);
  const hasDuplicateReturns = new Set(returnProductIds).size !== returnProductIds.length;
  const validReturns =
    !hasDuplicateReturns &&
    returns.every(
      (line) =>
        !!line.productCatalogId &&
        Number.isInteger(Number(line.quantity)) &&
        Number(line.quantity) > 0,
    );
  const isValid = formValidation.isValid && !!reason && validReturns;

  function updateReturn(id: number, patch: Partial<ReturnLine>) {
    setReturns((lines) => lines.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function addReturn() {
    const id = nextReturnId.current++;
    setReturns((lines) => [
      ...lines,
      { id, productCatalogId: null, quantity: '1', vendorInstruction: 'ask_if_damaged' },
    ]);
  }

  async function submit() {
    setError(null);
    if (!form || !isValid || !reason) {
      setError('Complete the replacement details and every return line.');
      return;
    }
    setSubmitting(true);
    try {
      const deliveryId = await createReplacement({
        clientUuid: clientUuid.current,
        clientId: form.clientId!,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        customerPhoneAlt: form.customerPhoneAlt.trim() || null,
        rawAddress: form.rawAddress.trim(),
        locationId: form.locationId!,
        scheduledDate: form.scheduledDate || todayLagos(),
        assignedAgentId: form.assignedAgentId,
        outboundItems: completeLines(form.items).map((line) => ({
          productCatalogId: line.productCatalogId,
          quantity: line.quantityOrdered,
        })),
        returnItems: returns.map((line) => ({
          productCatalogId: line.productCatalogId!,
          quantity: Number(line.quantity),
          vendorInstruction: line.vendorInstruction,
        })),
        reason,
        notes: notes.trim() || null,
        successClientCharge: showClientCharge ? amount(clientCharge) : 0,
        successAgentPayment: amount(agentPayment),
      });
      router.replace({
        pathname: `${basePath}/deliveries/[id]` as '/(admin)/deliveries/[id]',
        params: { id: deliveryId },
      });
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
        title="New replacement"
        subtitle="Plan the trip and returned item"
        onBack={() => router.back()}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        <Banner tone="info" icon="refresh">
          The outgoing product leaves the rider&apos;s stock when the replacement succeeds. A
          returned product stays in rider custody until warehouse receives and inspects it.
        </Banner>

        <DeliveryFieldsForm
          initial={{ scheduledDate: todayLagos(), customerPrice: 0 }}
          hideFields={['customerPrice']}
          onChange={onFormChange}
        />

        <Card style={{ gap: 12 }}>
          <Text style={kicker}>Why are we replacing it?</Text>
          <Select
            label="Reason"
            value={reason}
            options={Object.entries(REPLACEMENT_REASON_LABELS).map(([value, label]) => ({
              value: value as ReplacementReason,
              label,
            }))}
            onChange={setReason}
            required
          />
          <Input
            label="Instructions for the rider"
            value={notes}
            onChange={setNotes}
            placeholder="e.g. Replace Normal Arabian Tea with Double Arabian Tea"
            multiline
          />
        </Card>

        <Card style={{ gap: 12 }}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <View style={{ flex: 1 }}>
              <Text style={kicker}>Product expected back</Text>
              <Text style={helper}>Record what the rider may collect from the customer.</Text>
            </View>
            <Button variant="secondary" size="sm" icon="plus" onPress={addReturn}>
              Add
            </Button>
          </View>
          {returns.map((line, index) => (
            <View key={line.id} style={{ gap: 8, paddingTop: index === 0 ? 0 : 10 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Select
                    label={`Returned product ${index + 1}`}
                    value={line.productCatalogId}
                    options={productOptions}
                    onChange={(value) => updateReturn(line.id, { productCatalogId: value })}
                    placeholder={loadingProducts ? 'Loading products…' : 'Select product'}
                    searchable
                  />
                </View>
                <View style={{ width: 72 }}>
                  <Input
                    label="Qty"
                    value={line.quantity}
                    onChange={(value) => updateReturn(line.id, { quantity: value })}
                    keyboardType="numeric"
                  />
                </View>
                {returns.length > 1 ? (
                  <Pressable
                    onPress={() => setReturns((rows) => rows.filter((row) => row.id !== line.id))}
                    accessibilityLabel={`Remove returned product ${index + 1}`}
                    style={removeButton}
                  >
                    <Icon name="trash" size={17} color={colors.red} />
                  </Pressable>
                ) : null}
              </View>
              <Select
                label="If the old product is damaged"
                value={line.vendorInstruction}
                options={Object.entries(RETURN_INSTRUCTION_LABELS).map(([value, label]) => ({
                  value: value as ReturnInstruction,
                  label,
                }))}
                onChange={(value) => updateReturn(line.id, { vendorInstruction: value })}
              />
            </View>
          ))}
        </Card>

        <Card style={{ gap: 12 }}>
          <Text style={kicker}>Replacement trip fee</Text>
          <Text style={helper}>
            These apply only when the replacement succeeds. A failed attempt can be charged
            separately when the rider records it.
          </Text>
          {showClientCharge ? (
            <Input
              label="Charge client (₦)"
              value={clientCharge}
              onChange={setClientCharge}
              keyboardType="numeric"
            />
          ) : null}
          <Input
            label="Pay rider (₦)"
            value={agentPayment}
            onChange={setAgentPayment}
            keyboardType="numeric"
          />
        </Card>

        {!formValidation.isValid ? <MissingFieldsBanner missing={formValidation.missing} /> : null}
        {!validReturns ? (
          <Banner tone="warn" icon="alert">
            {hasDuplicateReturns
              ? 'Combine duplicate returned products into one quantity.'
              : 'Select a product and positive quantity for every expected return.'}
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <Button
          full
          variant="emphasis"
          icon="check"
          onPress={submit}
          disabled={!isValid || submitting}
        >
          {submitting ? 'Creating…' : 'Create replacement'}
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};

const helper = {
  fontFamily: fonts.medium,
  fontSize: 12,
  lineHeight: 17,
  color: colors.textSecondary,
};

const removeButton = {
  width: 40,
  height: 40,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 10,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
