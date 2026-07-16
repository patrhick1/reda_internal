import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useAsync } from '@/hooks/useAsync';
import { listActiveProductsByClient, type Product } from '@/services/products';
import { useClients, useLocations } from '@/hooks/queries';
import { listUsers, type AppUser } from '@/services/users';
import { getAgentProductsStock } from '@/services/deliveries';
import { Avatar, Banner, Card, DateField, Empty, Input } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

/** [Feature A] One editable product line. */
export type DeliveryLineDraft = {
  productCatalogId: string | null;
  quantityOrdered: number | null; // null when blank or NaN
};

/** Form values emitted by `<DeliveryFieldsForm>` on every change. */
export type DeliveryFormState = {
  clientId: string | null;
  /** [Feature A] The full line-item set (≥1 row). */
  items: DeliveryLineDraft[];
  /** Legacy primary = items[0], kept in sync so existing callers and the RPC's
   *  dual-write legacy columns keep working. */
  productCatalogId: string | null;
  quantityOrdered: number | null;
  customerName: string;
  customerPhone: string;
  customerPhoneAlt: string;
  rawAddress: string;
  deliveryInstructions: string;
  customerPrice: number | null;
  locationId: string | null;
  assignedAgentId: string | null;
  scheduledDate: string; // YYYY-MM-DD (empty allowed; parent validates)
};

/** Drop incomplete lines and keep the legacy primary (productCatalogId /
 *  quantityOrdered) pointed at the first complete line. */
function withDerivedPrimary(s: DeliveryFormState): DeliveryFormState {
  const firstComplete = s.items.find(
    (li) => li.productCatalogId && li.quantityOrdered != null && li.quantityOrdered > 0,
  );
  return {
    ...s,
    productCatalogId: firstComplete?.productCatalogId ?? s.items[0]?.productCatalogId ?? null,
    quantityOrdered: firstComplete?.quantityOrdered ?? s.items[0]?.quantityOrdered ?? null,
  };
}

/** The complete, submittable line items (product set + positive qty). */
export function completeLines(items: DeliveryLineDraft[]): {
  productCatalogId: string;
  quantityOrdered: number;
}[] {
  return items
    .filter(
      (li): li is { productCatalogId: string; quantityOrdered: number } =>
        !!li.productCatalogId && li.quantityOrdered != null && li.quantityOrdered > 0,
    )
    .map((li) => ({ productCatalogId: li.productCatalogId, quantityOrdered: li.quantityOrdered }));
}

export type DeliveryFormInitial = Partial<DeliveryFormState>;

export type ProductCandidate = {
  id: string;
  client_id: string;
  client_name: string;
  product_name: string;
  score: number;
};

export type ProductCandidateGroup = {
  lineIndex: number;
  productName: string;
  candidates: ProductCandidate[];
};

export type DeliveryFieldsFormProps = {
  initial?: DeliveryFormInitial;
  /** Hide fields not relevant to this flow. */
  hideFields?: readonly ('scheduledDate' | 'assignedAgent')[];
  /** Product candidates from the bot's parse_result; rendered as tappable
   *  chips above the product picker. Tapping a chip selects both client +
   *  product. Pass null when there's no ambiguity to surface. */
  productCandidateGroups?: ProductCandidateGroup[] | null;
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
  { key: 'customerPrice', label: 'Customer price' },
  // Location is required so a manual order is never saved "Unmatched" — an
  // unmatched delivery has no rate and can't be marked delivered. (The bot
  // already refuses to place an order it can't match; this aligns manual entry.)
  { key: 'locationId', label: 'Location' },
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
    if (key === 'customerPrice') {
      if (!Number.isFinite(v as number) || (v as number) < 0) missing.push('Customer price');
    }
  }
  // [Feature A] At least one complete product line. A line is incomplete if it
  // has a product without a positive qty, or a qty without a product.
  const lines = completeLines(s.items);
  if (lines.length === 0) {
    missing.push('At least one product line');
  }
  const partial = s.items.some(
    (li) =>
      (li.productCatalogId && (li.quantityOrdered == null || li.quantityOrdered <= 0)) ||
      (!li.productCatalogId && li.quantityOrdered != null && li.quantityOrdered > 0),
  );
  if (partial) missing.push('Complete every product line (product + qty)');
  // Duplicate product lines aren't allowed (the server unions them anyway).
  const ids = lines.map((l) => l.productCatalogId);
  if (new Set(ids).size !== ids.length) missing.push('Remove duplicate product lines');
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
  productCandidateGroups,
  onChange,
}: DeliveryFieldsFormProps) {
  const hide = useMemo(() => new Set(hideFields ?? []), [hideFields]);

  const clientsQ = useClients();
  const locationsQ = useLocations();
  const agentsQ = useAsync<AppUser[]>(
    () => listUsers().then((all) => all.filter((u) => u.role === 'agent' && u.is_active)),
    [],
  );

  const initialItems: DeliveryLineDraft[] =
    initial?.items && initial.items.length > 0
      ? initial.items
      : initial?.productCatalogId
        ? [
            {
              productCatalogId: initial.productCatalogId,
              quantityOrdered: initial.quantityOrdered ?? null,
            },
          ]
        : [{ productCatalogId: null, quantityOrdered: null }];

  const [state, setState] = useState<DeliveryFormState>({
    clientId: initial?.clientId ?? null,
    items: initialItems,
    productCatalogId: initialItems[0]?.productCatalogId ?? null,
    customerName: initial?.customerName ?? '',
    customerPhone: initial?.customerPhone ?? '',
    customerPhoneAlt: initial?.customerPhoneAlt ?? '',
    rawAddress: initial?.rawAddress ?? '',
    deliveryInstructions: initial?.deliveryInstructions ?? '',
    quantityOrdered: initialItems[0]?.quantityOrdered ?? null,
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
        // Drop any line whose product isn't in the new client's catalog.
        setState((s) => ({
          ...s,
          items: s.items.map((li) =>
            li.productCatalogId && !list.find((p) => p.id === li.productCatalogId)
              ? { ...li, productCatalogId: null }
              : li,
          ),
        }));
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

  // [Feature A] On-hand for the SELECTED agent across every line product, so we
  // can render a per-line pickup-needed warning. Map of productCatalogId → qty.
  const [agentStock, setAgentStock] = useState<Record<string, number> | null>(null);
  const lineProductIds = useMemo(
    () => state.items.map((li) => li.productCatalogId).filter((x): x is string => !!x),
    [state.items],
  );
  useEffect(() => {
    const agentId = state.assignedAgentId;
    if (!agentId || lineProductIds.length === 0) {
      setAgentStock(null);
      return;
    }
    let cancelled = false;
    getAgentProductsStock(agentId, lineProductIds)
      .then((m) => {
        if (!cancelled) setAgentStock(m);
      })
      .catch(() => {
        if (!cancelled) setAgentStock({});
      });
    return () => {
      cancelled = true;
    };
  }, [state.assignedAgentId, lineProductIds]);

  // Emit the latest state on every change, with the legacy primary derived.
  useEffect(() => {
    const emitted = withDerivedPrimary(state);
    onChange(emitted, validateState(emitted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function patch(p: Partial<DeliveryFormState>) {
    setState((s) => ({ ...s, ...p }));
  }

  // [Feature A] line-item editors
  function updateLine(i: number, p: Partial<DeliveryLineDraft>) {
    setState((s) => ({
      ...s,
      items: s.items.map((li, idx) => (idx === i ? { ...li, ...p } : li)),
    }));
  }
  function addLine() {
    setState((s) => ({
      ...s,
      items: [...s.items, { productCatalogId: null, quantityOrdered: null }],
    }));
  }
  function removeLine(i: number) {
    setState((s) => ({
      ...s,
      items: s.items.length <= 1 ? s.items : s.items.filter((_, idx) => idx !== i),
    }));
  }

  const locationOptions = useMemo(
    () => (locationsQ.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    [locationsQ.data],
  );
  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: p.product_name })),
    [products],
  );
  const agentOptions = useMemo(
    () =>
      (agentsQ.data ?? []).map((a) => ({
        value: a.id,
        label: a.display_name,
        sub: a.email ?? undefined,
      })),
    [agentsQ.data],
  );

  const selectedAgent = state.assignedAgentId
    ? (agentsQ.data ?? []).find((u) => u.id === state.assignedAgentId)
    : null;

  // [Feature A] Per-line stock shortfall for the assigned agent.
  const lineShortfalls = useMemo(() => {
    if (state.assignedAgentId == null || agentStock == null) return [];
    return completeLines(state.items)
      .map((l) => ({
        name: products.find((p) => p.id === l.productCatalogId)?.product_name ?? 'product',
        onHand: agentStock[l.productCatalogId] ?? 0,
        needed: l.quantityOrdered,
      }))
      .filter((s) => s.onHand < s.needed);
  }, [state.assignedAgentId, agentStock, state.items, products]);

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
        <View style={{ height: 16 }} />
        <Input
          label="Alternative phone (optional)"
          value={state.customerPhoneAlt}
          onChange={(v) => patch({ customerPhoneAlt: v })}
          icon="phone"
          keyboardType="phone-pad"
          autoCapitalize="none"
          placeholder="Backup number, if any"
        />
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
        <View style={{ height: 16 }} />
        <Input
          label="Delivery instructions (optional)"
          value={state.deliveryInstructions}
          onChange={(v) => patch({ deliveryInstructions: v })}
          icon="message"
          multiline
          numberOfLines={3}
          placeholder="Use side gate · call on arrival · ask for the gateman"
          helper="The agent sees this when delivering."
        />
      </Card>

      {/* Candidate choices belong to a specific unresolved parsed line. */}
      {productCandidateGroups?.map((group) =>
        group.candidates.length > 1 ? (
          <Card key={group.lineIndex}>
            <Text style={kicker}>Choose product for {group.productName}</Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 6,
              }}
            >
              The bot could not confidently match this line. Tap the right product.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {group.candidates.map((c) => {
                const active =
                  state.items[group.lineIndex]?.productCatalogId === c.id &&
                  state.clientId === c.client_id;
                return (
                  <Pressable
                    key={c.id}
                    onPress={() =>
                      setState((s) => ({
                        ...s,
                        clientId: c.client_id,
                        items: s.items.map((li, idx) =>
                          idx === group.lineIndex ? { ...li, productCatalogId: c.id } : li,
                        ),
                      }))
                    }
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
        ) : null,
      )}

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

      {/* Product line items */}
      {state.clientId ? (
        <Card>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={kicker}>Products</Text>
            {!loadingProducts && !productsError && products.length > 0 ? (
              <Pressable
                onPress={addLine}
                style={({ pressed }) => [
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1.5,
                    borderColor: colors.black,
                    backgroundColor: colors.white,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: colors.black }}>
                  + Add line
                </Text>
              </Pressable>
            ) : null}
          </View>
          <View style={{ marginTop: 10, gap: 10 }}>
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
              state.items.map((li, i) => {
                const onHand =
                  li.productCatalogId && agentStock ? agentStock[li.productCatalogId] : undefined;
                const needed = li.quantityOrdered;
                const short =
                  state.assignedAgentId != null &&
                  onHand != null &&
                  needed != null &&
                  needed > 0 &&
                  onHand < needed;
                return (
                  <View key={i} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                      <View style={{ flex: 1 }}>
                        <Select
                          label={i === 0 ? 'Product' : ''}
                          value={li.productCatalogId}
                          options={productOptions}
                          onChange={(v) => updateLine(i, { productCatalogId: v })}
                          placeholder="Select product"
                        />
                      </View>
                      <View style={{ width: 64 }}>
                        <Input
                          label={i === 0 ? 'Qty' : ''}
                          value={li.quantityOrdered == null ? '' : String(li.quantityOrdered)}
                          onChange={(v) =>
                            updateLine(i, { quantityOrdered: v === '' ? null : Number(v) })
                          }
                          keyboardType="numeric"
                        />
                      </View>
                      {state.items.length > 1 ? (
                        <Pressable
                          onPress={() => removeLine(i)}
                          accessibilityLabel={`Remove line ${i + 1}`}
                          style={({ pressed }) => [
                            {
                              width: 40,
                              height: 40,
                              borderRadius: 12,
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderWidth: 1.5,
                              borderColor: colors.border,
                            },
                            pressed && { opacity: 0.6 },
                          ]}
                        >
                          <Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.red }}>
                            ×
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {short ? (
                      <Text
                        style={{
                          fontFamily: fonts.medium,
                          fontSize: 11,
                          color: colors.warningDark,
                        }}
                      >
                        {selectedAgent?.display_name ?? 'Agent'} has {onHand} — pickup of{' '}
                        {needed! - onHand!} needed.
                      </Text>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        </Card>
      ) : null}

      {/* Numbers */}
      <Card>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Input
              label="Customer price (₦) — order total"
              value={state.customerPrice == null ? '' : String(state.customerPrice)}
              onChange={(v) => patch({ customerPrice: v === '' ? null : Number(v) })}
              keyboardType="numeric"
            />
          </View>
        </View>
        {!hide.has('scheduledDate') ? (
          <>
            <View style={{ height: 16 }} />
            <DateField
              label="Scheduled date"
              value={state.scheduledDate}
              onChange={(v) => patch({ scheduledDate: v })}
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
          required
          placeholder="Match to the delivery area"
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
            {lineShortfalls.length > 0 ? (
              <Banner tone="warn" icon="alert" title="Stock pickup needed">
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.warningDark,
                    lineHeight: 19,
                  }}
                >
                  {selectedAgent?.display_name ?? 'Selected agent'} is short on{' '}
                  {lineShortfalls.map((s) => `${s.needed - s.onHand} ${s.name}`).join(', ')}.
                  We&apos;ll prompt them to pick up from the warehouse and ping dispatch to issue a
                  transfer.
                </Text>
              </Banner>
            ) : null}
          </>
        ) : null}
      </Card>
    </View>
  );
}
