import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useAsync } from '@/hooks/useAsync';
import { listClients, type Client } from '@/services/clients';
import { listActiveProductsByClient, type Product } from '@/services/products';
import { listLocations, type Location } from '@/services/locations';
import { listUsers, type AppUser } from '@/services/users';
import { getAgentProductStock } from '@/services/deliveries';
import { Avatar, Banner, Card, Empty, Input } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

/** Form values emitted by `<DeliveryFieldsForm>` on every change. */
export type DeliveryFormState = {
  clientId: string | null;
  productCatalogId: string | null;
  customerName: string;
  customerPhone: string;
  rawAddress: string;
  quantityOrdered: number | null; // null when blank or NaN
  customerPrice: number | null;
  locationId: string | null;
  assignedAgentId: string | null;
  scheduledDate: string; // YYYY-MM-DD (empty allowed; parent validates)
};

export type DeliveryFormInitial = Partial<DeliveryFormState>;

export type ProductCandidate = {
  id: string;
  client_id: string;
  client_name: string;
  product_name: string;
  score: number;
};

export type DeliveryFieldsFormProps = {
  initial?: DeliveryFormInitial;
  /** Hide fields not relevant to this flow. */
  hideFields?: readonly ('scheduledDate' | 'assignedAgent')[];
  /** Product candidates from the bot's parse_result; rendered as tappable
   *  chips above the product picker. Tapping a chip selects both client +
   *  product. Pass null when there's no ambiguity to surface. */
  productCandidates?: ProductCandidate[] | null;
  /** When the contractor sent "x or y" as the phone, pass the *other* number
   *  here. We render a one-tap "Use 080... instead" link under the phone. */
  alternatePhone?: string | null;
  /** Fired on every field change with the latest state + a validation summary.
   *  `missing` lists the human-readable labels of fields the operator still
   *  needs to fill or correct. `isValid` is `missing.length === 0`. */
  onChange: (state: DeliveryFormState, validation: FormValidation) => void;
};

export type FormValidation = { isValid: boolean; missing: string[] };

/** Required field → label shown to the operator when it's missing. Order
 *  matches the on-screen layout so the hint list reads top-to-bottom. */
const REQUIRED_FIELDS: { key: keyof DeliveryFormState; label: string }[] = [
  { key: 'customerName', label: 'Customer name' },
  { key: 'customerPhone', label: 'Phone' },
  { key: 'rawAddress', label: 'Address' },
  { key: 'clientId', label: 'Client' },
  { key: 'productCatalogId', label: 'Product' },
  { key: 'quantityOrdered', label: 'Quantity' },
  { key: 'customerPrice', label: 'Customer price' },
];

/** Info banner that names what the operator still has to fill before they can
 *  submit. Returns null when nothing is missing — safe to drop into any screen
 *  unconditionally next to the submit button. */
export function MissingFieldsBanner({
  missing,
}: {
  missing: readonly string[];
}): ReactElement | null {
  if (missing.length === 0) return null;
  return (
    <Banner tone="info" icon="alert">
      <Text
        style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.infoDark, lineHeight: 19 }}
      >
        {missingFieldsMessage(missing)}
      </Text>
    </Banner>
  );
}

/** Render the missing-field list into a short, operator-friendly sentence.
 *  - 1 missing: "Fill in Quantity to continue."
 *  - 2 missing: "Fill in Quantity and Product to continue."
 *  - 3-4: comma list with Oxford 'and'.
 *  - 5+: cap with "+N more" so the banner doesn't blow up. */
export function missingFieldsMessage(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) return `Fill in ${missing[0]} to continue.`;
  if (missing.length === 2) return `Fill in ${missing[0]} and ${missing[1]} to continue.`;
  if (missing.length <= 4) {
    const head = missing.slice(0, -1).join(', ');
    const tail = missing[missing.length - 1];
    return `Fill in ${head}, and ${tail} to continue.`;
  }
  const shown = missing.slice(0, 4).join(', ');
  const rest = missing.length - 4;
  return `Fill in ${shown} (+${rest} more) to continue.`;
}

function validateState(s: DeliveryFormState): FormValidation {
  const missing: string[] = [];
  for (const { key, label } of REQUIRED_FIELDS) {
    const v = s[key];
    if (v === null || v === undefined || v === '') {
      missing.push(label);
      continue;
    }
    if (key === 'quantityOrdered') {
      if (!Number.isInteger(v) || (v as number) <= 0)
        missing.push('Quantity (positive whole number)');
    } else if (key === 'customerPrice') {
      if (!Number.isFinite(v as number) || (v as number) < 0) missing.push('Customer price');
    }
  }
  return { isValid: missing.length === 0, missing };
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};

export function DeliveryFieldsForm({
  initial,
  hideFields,
  productCandidates,
  alternatePhone,
  onChange,
}: DeliveryFieldsFormProps) {
  const hide = useMemo(() => new Set(hideFields ?? []), [hideFields]);

  const clientsQ = useAsync<Client[]>(() => listClients(), []);
  const locationsQ = useAsync<Location[]>(() => listLocations(), []);
  const agentsQ = useAsync<AppUser[]>(
    () => listUsers().then((all) => all.filter((u) => u.role === 'agent' && u.is_active)),
    [],
  );

  const [state, setState] = useState<DeliveryFormState>({
    clientId: initial?.clientId ?? null,
    productCatalogId: initial?.productCatalogId ?? null,
    customerName: initial?.customerName ?? '',
    customerPhone: initial?.customerPhone ?? '',
    rawAddress: initial?.rawAddress ?? '',
    quantityOrdered: initial?.quantityOrdered ?? null,
    customerPrice: initial?.customerPrice ?? null,
    locationId: initial?.locationId ?? null,
    assignedAgentId: initial?.assignedAgentId ?? null,
    scheduledDate: initial?.scheduledDate ?? '',
  });

  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);

  // Refetch the product list whenever the client changes. Clear the product
  // selection if the new client doesn't have the previously-selected product.
  useEffect(() => {
    if (!state.clientId) {
      setProducts([]);
      return;
    }
    let cancelled = false;
    setLoadingProducts(true);
    setProductsError(null);
    listActiveProductsByClient(state.clientId)
      .then((list) => {
        if (cancelled) return;
        setProducts(list);
        // If the current product isn't in the new list, drop it.
        if (state.productCatalogId && !list.find((p) => p.id === state.productCatalogId)) {
          patch({ productCatalogId: null });
        }
      })
      .catch((e) => {
        if (!cancelled) setProductsError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.clientId]);

  // Per-agent stock for the selected product, so the picker can show "X in
  // stock" inline and we can render the pickup-needed banner.
  const [stockByAgent, setStockByAgent] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    const productId = state.productCatalogId;
    const agents = agentsQ.data ?? [];
    if (!productId || agents.length === 0) {
      setStockByAgent(null);
      return;
    }
    let cancelled = false;
    Promise.all(
      agents.map((a) =>
        getAgentProductStock(a.id, productId)
          .then((qty) => [a.id, qty] as const)
          .catch(() => [a.id, 0] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setStockByAgent(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [state.productCatalogId, agentsQ.data]);

  // Emit the latest state on every change.
  useEffect(() => {
    onChange(state, validateState(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function patch(p: Partial<DeliveryFormState>) {
    setState((s) => ({ ...s, ...p }));
  }

  const locationOptions = useMemo(
    () => (locationsQ.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    [locationsQ.data],
  );
  const agentOptions = useMemo(
    () =>
      (agentsQ.data ?? []).map((a) => {
        const stock = stockByAgent?.get(a.id);
        const label =
          stockByAgent == null ? a.display_name : `${a.display_name} · ${stock ?? 0} in stock`;
        return { value: a.id, label, sub: a.email ?? undefined };
      }),
    [agentsQ.data, stockByAgent],
  );

  const selectedAgent = state.assignedAgentId
    ? (agentsQ.data ?? []).find((u) => u.id === state.assignedAgentId)
    : null;
  const selectedProductName = state.productCatalogId
    ? products.find((p) => p.id === state.productCatalogId)?.product_name
    : null;
  const stockShortfall = (() => {
    if (state.assignedAgentId == null) return null;
    if (stockByAgent == null) return null;
    const onHand = stockByAgent.get(state.assignedAgentId) ?? 0;
    const needed = state.quantityOrdered;
    if (needed == null || !Number.isInteger(needed) || needed <= 0) return null;
    return onHand < needed ? { onHand, needed } : null;
  })();

  if (clientsQ.loading || locationsQ.loading || agentsQ.loading) {
    return (
      <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 40 }}>
        <ActivityIndicator color={colors.black} />
      </View>
    );
  }
  if (clientsQ.error || locationsQ.error || agentsQ.error) {
    return (
      <Empty
        icon="alert"
        title="Could not load"
        sub={clientsQ.error || locationsQ.error || agentsQ.error || ''}
      />
    );
  }
  if ((clientsQ.data ?? []).length === 0) {
    return (
      <Empty
        icon="package"
        title="No clients yet"
        sub="Add at least one active client in Catalog before creating or editing a delivery."
      />
    );
  }

  return (
    <View style={{ gap: 16 }}>
      <Card>
        <Input
          label="Customer name"
          value={state.customerName}
          onChange={(v) => patch({ customerName: v })}
          autoCapitalize="words"
          placeholder="Akoro Edidi"
        />
        <View style={{ height: 16 }} />
        <Input
          label="Phone"
          value={state.customerPhone}
          onChange={(v) => patch({ customerPhone: v })}
          icon="phone"
          keyboardType="phone-pad"
          autoCapitalize="none"
          placeholder="+234 805…"
        />
        {alternatePhone ? (
          <View style={{ marginTop: 6 }}>
            <Pressable onPress={() => patch({ customerPhone: alternatePhone })}>
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.red }}>
                Use {alternatePhone} instead
              </Text>
            </Pressable>
          </View>
        ) : null}
        <View style={{ height: 16 }} />
        <Input
          label="Address"
          value={state.rawAddress}
          onChange={(v) => patch({ rawAddress: v })}
          icon="mapPin"
          multiline
          numberOfLines={2}
          placeholder="17 Admiralty Way, Lekki"
          helper="Plain text — the bot pipeline matches this to a known location."
        />
      </Card>

      {/* Product-candidate chips (review-flow only) */}
      {productCandidates && productCandidates.length > 1 ? (
        <Card>
          <Text style={kicker}>The bot saw more than one match</Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 6,
            }}
          >
            Tap the right one — it will fill in the client and product below.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {productCandidates.map((c) => {
              const active = state.productCatalogId === c.id && state.clientId === c.client_id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => patch({ clientId: c.client_id, productCatalogId: c.id })}
                  style={({ pressed }) => [
                    {
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 999,
                      backgroundColor: active ? colors.black : colors.white,
                      borderWidth: 1.5,
                      borderColor: active ? colors.black : colors.border,
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text
                    style={{
                      fontFamily: fonts.semibold,
                      fontSize: 13,
                      color: active ? colors.white : colors.black,
                    }}
                  >
                    {c.product_name} · {c.client_name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>
      ) : null}

      {/* Client picker */}
      <Card>
        <Text style={kicker}>Client</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {(clientsQ.data ?? []).map((c) => {
            const active = state.clientId === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => patch({ clientId: c.id, productCatalogId: null })}
                style={({ pressed }) => [
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: active ? colors.black : colors.white,
                    borderWidth: 1.5,
                    borderColor: active ? colors.black : colors.border,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text
                  style={{
                    fontFamily: fonts.semibold,
                    fontSize: 13,
                    color: active ? colors.white : colors.black,
                  }}
                >
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* Product picker */}
      {state.clientId ? (
        <Card>
          <Text style={kicker}>Product</Text>
          <View style={{ marginTop: 10, gap: 6 }}>
            {loadingProducts ? (
              <ActivityIndicator color={colors.black} />
            ) : productsError ? (
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.red }}>
                {productsError}
              </Text>
            ) : products.length === 0 ? (
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
                This client has no active products yet.
              </Text>
            ) : (
              products.map((p) => {
                const active = state.productCatalogId === p.id;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => patch({ productCatalogId: p.id })}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                        borderRadius: 12,
                        backgroundColor: active ? colors.surface : 'transparent',
                        borderWidth: 1.5,
                        borderColor: active ? colors.black : colors.border,
                      },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Text
                      style={{
                        flex: 1,
                        fontFamily: fonts.semibold,
                        fontSize: 14,
                        color: colors.black,
                      }}
                    >
                      {p.product_name}
                    </Text>
                    {p.description ? (
                      <Text
                        style={{
                          fontFamily: fonts.medium,
                          fontSize: 12,
                          color: colors.textSecondary,
                          marginLeft: 8,
                        }}
                      >
                        {p.description}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </View>
        </Card>
      ) : null}

      {/* Numbers */}
      <Card>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 90 }}>
            <Input
              label="Qty"
              value={state.quantityOrdered == null ? '' : String(state.quantityOrdered)}
              onChange={(v) => patch({ quantityOrdered: v === '' ? null : Number(v) })}
              keyboardType="numeric"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Input
              label="Customer price (₦)"
              value={state.customerPrice == null ? '' : String(state.customerPrice)}
              onChange={(v) => patch({ customerPrice: v === '' ? null : Number(v) })}
              keyboardType="numeric"
            />
          </View>
        </View>
        {!hide.has('scheduledDate') ? (
          <>
            <View style={{ height: 16 }} />
            <Input
              label="Scheduled date"
              value={state.scheduledDate}
              onChange={(v) => patch({ scheduledDate: v })}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="YYYY-MM-DD"
              icon="calendar"
            />
          </>
        ) : null}
      </Card>

      {/* Location + agent */}
      <Card>
        <Select
          label="Location"
          value={state.locationId}
          options={locationOptions}
          onChange={(v) => patch({ locationId: v })}
          placeholder="Optional — leave empty to flag for review"
        />
        {!hide.has('assignedAgent') ? (
          <>
            <Select
              label="Assigned agent (optional)"
              value={state.assignedAgentId}
              options={agentOptions}
              onChange={(v) => patch({ assignedAgentId: v })}
              placeholder="Auto-assign by stock + workload"
            />
            {!state.assignedAgentId ? (
              <Banner tone="info" icon="bot">
                Agent will be auto-assigned based on stock and current workload.
              </Banner>
            ) : selectedAgent ? (
              <Banner tone="info" icon="user">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Avatar user={selectedAgent} size={24} />
                  <Text
                    style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.infoDark }}
                  >
                    Assigned to {selectedAgent.display_name}
                  </Text>
                </View>
              </Banner>
            ) : null}
            {stockShortfall ? (
              <Banner tone="warn" icon="alert" title="Stock pickup needed">
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.warningDark,
                    lineHeight: 19,
                  }}
                >
                  {selectedAgent?.display_name ?? 'Selected agent'} has {stockShortfall.onHand}
                  {selectedProductName ? ` ${selectedProductName}` : ''} but the delivery is for{' '}
                  {stockShortfall.needed}. We&apos;ll prompt them to pick up from the warehouse and
                  ping dispatch to issue a transfer.
                </Text>
              </Banner>
            ) : null}
          </>
        ) : null}
      </Card>
    </View>
  );
}
