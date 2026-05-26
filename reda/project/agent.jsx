// Agent role screens — Kenneth's daily flow.
const T_A = window.REDA_THEME;
const D_A = window.REDA_DATA;

// ───── helpers
const findClient = id => D_A.clients.find(c => c.id === id);
const findProduct = id => D_A.products.find(p => p.id === id);
const findLocation = id => D_A.locations.find(l => l.id === id);
const findUser = id => D_A.users[id];

const STATUS_GROUPS = {
  active: ['pending', 'available'],
  soft:   ['not_answering', 'number_busy', 'switched_off', 'tomorrow', 'postponed', 'follow_up'],
  done:   ['delivered'],
  closed: ['cancelled', 'failed', 'unserious', 'no_product', 'rolled_over'],
};

const statusBucket = (s) => {
  for (const k of Object.keys(STATUS_GROUPS)) if (STATUS_GROUPS[k].includes(s)) return k;
  return 'active';
};

// ────────────────────────────────────────────────────────────
// Agent Home — Today's deliveries
// ────────────────────────────────────────────────────────────
const AgentHome = ({ user, deliveries, onOpen, pillVariant, dark, density }) => {
  const myDels = deliveries.filter(d => d.agentId === user.id);
  const toCollect = myDels
    .filter(d => d.status !== 'delivered' && d.status !== 'cancelled')
    .reduce((s, d) => s + d.customerPrice, 0);
  const delivered = myDels.filter(d => d.status === 'delivered');
  const earned = delivered.reduce((s, d) => s + d.agentPayment, 0);

  const order = (a, b) => {
    const oa = ['active','soft','done','closed'].indexOf(statusBucket(a.status));
    const ob = ['active','soft','done','closed'].indexOf(statusBucket(b.status));
    return oa - ob;
  };

  const compact = density === 'compact';
  const headerDark = dark;

  return (
    <div style={{ background: T_A.colors.surface, minHeight: '100%' }}>
      {/* Hero header */}
      <div style={{
        background: headerDark ? T_A.colors.black : T_A.colors.white,
        color: headerDark ? '#FFFFFF' : T_A.colors.black,
        padding: '14px 16px 24px',
        borderBottom: `1px solid ${headerDark ? '#1f1f1f' : T_A.colors.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <RedaMark size={32} inverted={headerDark}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: headerDark ? '#A3A3A3' : T_A.colors.textSecondary, fontWeight: 500 }}>
              Wednesday, May 13
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Morning, {user.name.split(' ')[0]}.</div>
          </div>
          <div style={{ position: 'relative', padding: 8 }}>
            <Icon name="bell" size={22} color={headerDark ? '#FFFFFF' : T_A.colors.black}/>
            <div style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, background: T_A.colors.red, border: `1.5px solid ${headerDark ? T_A.colors.black : T_A.colors.white}` }}/>
          </div>
        </div>

        {/* Day summary */}
        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: headerDark ? '#222' : T_A.colors.border, borderRadius: 14, overflow: 'hidden' }}>
          {[
            { label: 'To collect', value: money(toCollect), accent: T_A.colors.red },
            { label: 'Earned today', value: money(earned), accent: T_A.colors.success },
            { label: 'Deliveries', value: `${delivered.length}/${myDels.length}`, accent: headerDark ? '#FFFFFF' : T_A.colors.black },
          ].map((s, i) => (
            <div key={i} style={{ padding: '12px 12px 14px', background: headerDark ? T_A.colors.black : T_A.colors.white }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: headerDark ? '#A3A3A3' : T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, letterSpacing: '-0.01em', color: s.accent }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* List */}
      <SectionHeader>Today · {myDels.length} stops</SectionHeader>
      <div style={{ padding: '0 16px 100px', display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
        {myDels.sort(order).map(d => {
          const client = findClient(d.clientId);
          const product = findProduct(d.productId);
          const location = findLocation(d.locationId);
          const isDone = d.status === 'delivered';
          return (
            <Card key={d.id} onClick={() => onOpen(d.id)} dense={compact}
              style={isDone ? { opacity: 0.65 } : {}}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 4, alignSelf: 'stretch', minHeight: 40,
                  background: statusBucket(d.status) === 'active' ? T_A.colors.red
                    : statusBucket(d.status) === 'soft' ? T_A.colors.warning
                    : statusBucket(d.status) === 'done' ? T_A.colors.success : T_A.colors.closed,
                  borderRadius: 4,
                }}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>{d.customer}</div>
                    <StatusPill status={d.status} variant={pillVariant} size="sm"/>
                  </div>
                  <div style={{ fontSize: 13, color: T_A.colors.textSecondary, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="mapPin" size={12}/>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{location?.name || 'Unmatched'}</span>
                  </div>
                  <div style={{ marginTop: compact ? 6 : 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 13, color: T_A.colors.black }}>
                      <span style={{ color: T_A.colors.textSecondary }}>{client?.name} · </span>
                      <span style={{ fontWeight: 600 }}>{product?.name}</span>
                      {d.qty > 1 && <span style={{ color: T_A.colors.textSecondary }}> × {d.qty}</span>}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>
                      {isDone ? <span style={{ color: T_A.colors.success }}>+{money(d.agentPayment)}</span> : money(d.customerPrice)}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Agent Delivery Detail
// ────────────────────────────────────────────────────────────
const AgentDeliveryDetail = ({ delivery, onBack, onMarkDelivered, onChangeStatus, pillVariant }) => {
  const d = delivery;
  const client = findClient(d.clientId);
  const product = findProduct(d.productId);
  const location = findLocation(d.locationId);
  const isTerminal = ['delivered','cancelled','failed','unserious','no_product','rolled_over'].includes(d.status);

  return (
    <div style={{ background: T_A.colors.surface, minHeight: '100%', position: 'relative' }}>
      <AppBar
        left={
          <button onClick={onBack} style={{ background: 'transparent', border: 0, padding: 4, marginLeft: -4, cursor: 'pointer' }}>
            <Icon name="chevronLeft" size={26}/>
          </button>
        }
        title={d.code}
        subtitle={`Created ${d.history[0]?.at} · via ${d.createdVia}`}
        right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="moreVertical" size={20}/></button>}
      />
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: isTerminal ? 100 : 140 }}>
        {/* Hero — customer + status */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Customer</div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 2 }}>{d.customer}</div>
            </div>
            <StatusPill status={d.status} variant={pillVariant}/>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Button variant="primary" icon="phone" full>Call {d.customer.split(' ')[0]}</Button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: T_A.colors.textSecondary, fontFamily: T_A.fontMono }}>{d.phone}</div>
        </Card>

        {/* Address */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Address</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 6, lineHeight: 1.45 }}>{d.rawAddress}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: T_A.colors.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="mapPin" size={13}/> {location?.name || 'Unmatched location'}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" icon="mapPin" size="sm">Open in maps</Button>
          </div>
        </Card>

        {/* Product + money */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Product</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{product?.name}</div>
              <div style={{ fontSize: 13, color: T_A.colors.textSecondary, marginTop: 2 }}>Quantity: {d.qty}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>To collect</div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 2 }}>{money(d.customerPrice)}</div>
            </div>
          </div>
          {d.status === 'delivered' && (
            <div style={{ marginTop: 12, padding: 10, background: T_A.colors.successSoft, borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>
                Delivered · {d.paymentMethod === 'cash' ? 'Cash' : 'Transfer'}
              </div>
              <div style={{ fontSize: 13, color: '#166534', fontWeight: 700 }}>
                You earned {money(d.agentPayment)}
              </div>
            </div>
          )}
        </Card>

        {/* Vendor card — notes prominent */}
        <Card style={{ background: client?.notes ? '#FFFBEB' : T_A.colors.white, border: client?.notes ? `1px solid #FCD34D` : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Vendor</div>
            <div style={{ fontSize: 13, color: T_A.colors.textSecondary }}>{client?.contact}</div>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{client?.name}</div>
          {client?.notes && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <Icon name="alert" size={18} color="#92400E"/>
              <div style={{ flex: 1, fontSize: 13.5, color: '#78350F', fontWeight: 600, lineHeight: 1.5 }}>{client.notes}</div>
            </div>
          )}
        </Card>

        {/* History */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: T_A.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>History</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[...d.history].reverse().map((h, i, arr) => (
              <div key={i} style={{ display: 'flex', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 5, background: i === 0 ? T_A.colors.black : T_A.colors.borderStrong }}/>
                  {i < arr.length - 1 && <div style={{ width: 2, flex: 1, background: T_A.colors.border, marginTop: 2 }}/>}
                </div>
                <div style={{ flex: 1, paddingBottom: i < arr.length - 1 ? 16 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusPill status={h.status} variant="subtle" size="sm"/>
                    <span style={{ fontSize: 12, color: T_A.colors.textSecondary, fontFamily: T_A.fontMono }}>{h.at}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, color: T_A.colors.black }}>{h.actor}</div>
                  {h.note && <div style={{ fontSize: 13, color: T_A.colors.textSecondary, marginTop: 2 }}>{h.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Sticky bottom action */}
      {!isTerminal && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          padding: '12px 16px 16px',
          background: 'linear-gradient(180deg, rgba(245,245,245,0), rgba(245,245,245,1) 30%)',
          display: 'flex', gap: 8,
        }}>
          <Button variant="secondary" size="md" onClick={onChangeStatus}>Update status</Button>
          <Button variant="emphasis" full onClick={onMarkDelivered}>Mark delivered</Button>
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Mark Delivered sheet
// ────────────────────────────────────────────────────────────
const MarkDeliveredSheet = ({ open, delivery, onClose, onConfirm }) => {
  const [qty, setQty] = React.useState(delivery?.qty || 1);
  const [paid, setPaid] = React.useState(delivery?.customerPrice || 0);
  const [method, setMethod] = React.useState('cash');
  React.useEffect(() => {
    if (delivery) { setQty(delivery.qty); setPaid(delivery.customerPrice); setMethod('cash'); }
  }, [delivery?.id]);
  if (!delivery) return null;
  const expected = delivery.customerPrice;
  const remit = paid - delivery.charged;
  return (
    <Sheet open={open} onClose={onClose} title="Mark delivered" subtitle={`${delivery.customer} · ${findProduct(delivery.productId)?.name}`}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 }}>
        <Input label="Quantity delivered" value={String(qty)} onChange={v => setQty(Number(v) || 0)} type="number"/>
        <Input label="Amount collected (₦)" value={String(paid)} onChange={v => setPaid(Number(v) || 0)} type="number" helper={`Expected: ${money(expected)}`}/>

        {/* Payment method */}
        <div>
          <div style={{ fontSize: 12, color: T_A.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Payment method</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'cash', label: 'Cash', icon: 'cash' },
              { id: 'transfer', label: 'Transfer', icon: 'bank' },
            ].map(m => {
              const active = method === m.id;
              return (
                <button key={m.id} onClick={() => setMethod(m.id)} style={{
                  flex: 1, minHeight: 56, padding: 12,
                  border: `2px solid ${active ? T_A.colors.black : T_A.colors.border}`,
                  borderRadius: 12, background: active ? T_A.colors.black : T_A.colors.white,
                  color: active ? '#FFFFFF' : T_A.colors.black, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  fontFamily: T_A.font, fontWeight: 700, fontSize: 14,
                }}>
                  <Icon name={m.icon} size={18}/>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {paid !== expected && (
          <Banner tone="warn" icon="alert" title={paid < expected ? 'Underpayment' : 'Overpayment'}>
            Difference of {money(Math.abs(paid - expected))}. Remit will reflect actual paid amount.
          </Banner>
        )}

        <div style={{ padding: 12, background: T_A.colors.surface, borderRadius: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T_A.colors.textSecondary, marginBottom: 4 }}>
            <span>Your earnings</span><span style={{ color: T_A.colors.black, fontWeight: 700 }}>{money(delivery.agentPayment)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T_A.colors.textSecondary }}>
            <span>Remit to Reda</span><span style={{ color: T_A.colors.black, fontWeight: 700 }}>{money(remit)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="emphasis" full icon="check" onClick={() => onConfirm({ qty, paid, method })}>Confirm delivery</Button>
        </div>
      </div>
    </Sheet>
  );
};

// ────────────────────────────────────────────────────────────
// Update status sheet (non-terminal transitions)
// ────────────────────────────────────────────────────────────
const UpdateStatusSheet = ({ open, delivery, onClose, onPick }) => {
  if (!delivery) return null;
  const opts = [
    { s: 'available',     hint: 'Customer reachable, on the way' },
    { s: 'not_answering', hint: "Called but didn't pick" },
    { s: 'number_busy',   hint: 'Line is busy' },
    { s: 'switched_off',  hint: 'Phone off' },
    { s: 'tomorrow',      hint: 'Customer wants tomorrow' },
    { s: 'postponed',     hint: 'Pushed later this week' },
  ];
  return (
    <Sheet open={open} onClose={onClose} title="Update status" subtitle={delivery.customer}>
      <div style={{ padding: '4px 12px 20px' }}>
        {opts.map(o => (
          <button key={o.s} onClick={() => onPick(o.s)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 12px', background: 'transparent', border: 0, borderRadius: 12,
            cursor: 'pointer', textAlign: 'left',
          }}>
            <StatusPill status={o.s} variant="filled"/>
            <span style={{ flex: 1, fontSize: 13.5, color: T_A.colors.textSecondary, fontFamily: T_A.font }}>{o.hint}</span>
            <Icon name="chevronRight" size={18} color={T_A.colors.textSecondary}/>
          </button>
        ))}
      </div>
    </Sheet>
  );
};

// ────────────────────────────────────────────────────────────
// My Stock (agent)
// ────────────────────────────────────────────────────────────
const AgentStock = ({ user }) => {
  const items = D_A.stock.filter(s => s.agentId === user.id);
  const total = items.reduce((s, i) => s + i.qty, 0);
  return (
    <div style={{ background: T_A.colors.surface, minHeight: '100%' }}>
      <AppBar title="My stock" subtitle={`${total} items across ${items.length} products`} right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="refresh" size={20}/></button>}/>
      <div style={{ padding: 16, paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(s => {
          const p = findProduct(s.productId);
          const c = findClient(p?.client);
          const low = s.qty <= 3;
          return (
            <Card key={s.productId} dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: low ? T_A.colors.redSoft : T_A.colors.surface,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon name="package" size={20} color={low ? T_A.colors.red : T_A.colors.black}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{p?.name}</div>
                  <div style={{ fontSize: 12, color: T_A.colors.textSecondary, marginTop: 2 }}>{c?.name}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: low ? T_A.colors.red : T_A.colors.black }}>{s.qty}</div>
                  {low && <div style={{ fontSize: 10, fontWeight: 700, color: T_A.colors.red, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Low</div>}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// My Earnings (agent)
// ────────────────────────────────────────────────────────────
const AgentEarnings = ({ user, deliveries }) => {
  const mine = deliveries.filter(d => d.agentId === user.id && d.status === 'delivered');
  const today = mine.reduce((s, d) => s + d.agentPayment, 0);
  // Synthetic week/month numbers
  const week = today + 18400;
  const month = week + 72500;

  return (
    <div style={{ background: T_A.colors.surface, minHeight: '100%' }}>
      <AppBar title="My earnings" subtitle="Paid every Friday"/>
      <div style={{ padding: 16, paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Big number */}
        <Card style={{ background: T_A.colors.black, color: '#FFFFFF' }}>
          <div style={{ fontSize: 11, color: '#A3A3A3', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>This week</div>
          <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', marginTop: 4 }}>{money(week)}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: '#A3A3A3' }}>Today</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{money(today)}</div>
            </div>
            <div style={{ width: 1, background: '#333' }}/>
            <div>
              <div style={{ fontSize: 11, color: '#A3A3A3' }}>This month</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{money(month)}</div>
            </div>
          </div>
        </Card>

        <SectionHeader>Today's deliveries</SectionHeader>
        {mine.length === 0 && <Empty icon="package" title="No deliveries yet today" sub="They'll show up here once marked delivered."/>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {mine.map(d => (
            <Card key={d.id} dense>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{d.customer}</div>
                  <div style={{ fontSize: 12, color: T_A.colors.textSecondary, marginTop: 2 }}>
                    {findProduct(d.productId)?.name} · {findLocation(d.locationId)?.name}
                  </div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: T_A.colors.success }}>+{money(d.agentPayment)}</div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { AgentHome, AgentDeliveryDetail, MarkDeliveredSheet, UpdateStatusSheet, AgentStock, AgentEarnings, STATUS_GROUPS, statusBucket, findClient, findProduct, findLocation, findUser });
