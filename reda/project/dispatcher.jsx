// Dispatcher screens — Amaka's flow.
const T_D = window.REDA_THEME;
const D_D = window.REDA_DATA;

// Shared filter chips
const FilterChips = ({ options, value, onChange }) => (
  <div style={{
    display: 'flex', gap: 6, padding: '0 16px 12px', overflowX: 'auto',
    fontFamily: T_D.font,
  }}>
    {options.map(o => {
      const active = o.id === value;
      return (
        <button key={o.id} onClick={() => onChange(o.id)} style={{
          padding: '6px 12px', borderRadius: 999,
          background: active ? T_D.colors.black : T_D.colors.white,
          color: active ? '#FFFFFF' : T_D.colors.black,
          border: `1px solid ${active ? T_D.colors.black : T_D.colors.border}`,
          fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}>
          {o.label} {o.count !== undefined && <span style={{ opacity: 0.7, marginLeft: 4 }}>{o.count}</span>}
        </button>
      );
    })}
  </div>
);

// ────────────────────────────────────────────────────────────
// Dispatcher Dashboard
// ────────────────────────────────────────────────────────────
const DispatcherHome = ({ user, deliveries, onOpen, onCreate, onNeedsReview }) => {
  const todays = deliveries;
  const byStatus = {
    active: todays.filter(d => statusBucket(d.status) === 'active').length,
    soft: todays.filter(d => statusBucket(d.status) === 'soft').length,
    done: todays.filter(d => statusBucket(d.status) === 'done').length,
    closed: todays.filter(d => statusBucket(d.status) === 'closed').length,
  };
  const needsReview = todays.filter(d => d.needsReview || !d.agentId);
  const totalVolume = todays.reduce((s, d) => s + d.customerPrice, 0);
  const agents = Object.values(D_D.users).filter(u => u.role === 'agent');

  return (
    <div style={{ background: T_D.colors.surface, minHeight: '100%', paddingBottom: 100 }}>
      <AppBar
        title="Operations"
        subtitle={`Wed 13 May · ${agents.length} agents active`}
        right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="bell" size={20}/></button>}
      />

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Big number */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: T_D.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Today's volume</div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.025em', marginTop: 4 }}>{money(totalVolume)}</div>
          <div style={{ fontSize: 13, color: T_D.colors.textSecondary, marginTop: 2 }}>across {todays.length} deliveries</div>

          {/* Status bar */}
          <div style={{ marginTop: 14, display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: T_D.colors.surface }}>
            {[
              { c: T_D.colors.red, v: byStatus.active },
              { c: T_D.colors.warning, v: byStatus.soft },
              { c: T_D.colors.success, v: byStatus.done },
              { c: T_D.colors.closed, v: byStatus.closed },
            ].map((s, i) => (
              <div key={i} style={{ background: s.c, flex: s.v || 0.001 }}/>
            ))}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: 11 }}>
            {[
              { label: 'Active', n: byStatus.active, c: T_D.colors.red },
              { label: 'Soft fail', n: byStatus.soft, c: T_D.colors.warning },
              { label: 'Delivered', n: byStatus.done, c: T_D.colors.success },
              { label: 'Closed', n: byStatus.closed, c: T_D.colors.closed },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: s.c }}/>
                <span style={{ color: T_D.colors.textSecondary }}>{s.label}</span>
                <span style={{ fontWeight: 700 }}>{s.n}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Needs review */}
        {needsReview.length > 0 && (
          <Card onClick={onNeedsReview} style={{ background: T_D.colors.black, color: '#FFFFFF' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#A3A3A3', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Needs review</div>
                <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 4 }}>{needsReview.length} {needsReview.length === 1 ? 'item' : 'items'}</div>
                <div style={{ fontSize: 12, color: '#A3A3A3', marginTop: 4 }}>AI couldn't match address or no agent has stock</div>
              </div>
              <div style={{ background: T_D.colors.red, width: 40, height: 40, borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="chevronRight" size={22} color="#FFFFFF"/>
              </div>
            </div>
          </Card>
        )}

        {/* Agent workload */}
        <SectionHeader right={<button style={{ background: 'transparent', border: 0, color: T_D.colors.textSecondary, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>See all →</button>}>
          Agent workload
        </SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map(a => {
            const aDels = deliveries.filter(d => d.agentId === a.id);
            const pending = aDels.filter(d => ['pending','available'].includes(d.status)).length;
            const done = aDels.filter(d => d.status === 'delivered').length;
            const total = aDels.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <Card key={a.id} dense>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Avatar user={a} size={40}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: T_D.colors.textSecondary, marginTop: 2 }}>
                      {done}/{total} delivered · {pending} pending
                    </div>
                    <div style={{ marginTop: 6, height: 4, background: T_D.colors.surface, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: T_D.colors.success, transition: 'width 300ms' }}/>
                    </div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' }}>{pct}%</div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <FAB icon="plus" label="Create" onClick={onCreate}/>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Deliveries list (with filters)
// ────────────────────────────────────────────────────────────
const DeliveriesList = ({ deliveries, onOpen, allowAssign }) => {
  const [filter, setFilter] = React.useState('all');
  const buckets = {
    all: deliveries,
    active: deliveries.filter(d => statusBucket(d.status) === 'active'),
    soft: deliveries.filter(d => statusBucket(d.status) === 'soft'),
    done: deliveries.filter(d => statusBucket(d.status) === 'done'),
    review: deliveries.filter(d => d.needsReview || !d.agentId),
  };
  const list = buckets[filter];

  return (
    <div style={{ background: T_D.colors.surface, minHeight: '100%' }}>
      <AppBar title="Deliveries" subtitle="Today" right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="search" size={20}/></button>}/>
      <div style={{ paddingTop: 12 }}>
        <FilterChips
          value={filter} onChange={setFilter}
          options={[
            { id: 'all', label: 'All', count: buckets.all.length },
            { id: 'active', label: 'Active', count: buckets.active.length },
            { id: 'soft', label: 'Soft fail', count: buckets.soft.length },
            { id: 'done', label: 'Done', count: buckets.done.length },
            { id: 'review', label: 'Review', count: buckets.review.length },
          ]}
        />
      </div>
      <div style={{ padding: '0 16px 100px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.length === 0 && <Empty icon="package" title="Nothing here" sub="Switch filters or wait for new deliveries."/>}
        {list.map(d => {
          const product = findProduct(d.productId);
          const location = findLocation(d.locationId);
          const agent = d.agentId ? findUser(d.agentId) : null;
          return (
            <Card key={d.id} onClick={() => onOpen(d.id)} dense>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{d.customer}</div>
                    <StatusPill status={d.status} variant="subtle" size="sm"/>
                  </div>
                  <div style={{ fontSize: 12, color: T_D.colors.textSecondary, marginTop: 2 }}>
                    {d.code} · {location?.name || <span style={{ color: T_D.colors.red, fontWeight: 600 }}>Unmatched</span>} · {product?.name}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {agent ? (
                        <>
                          <Avatar user={agent} size={20}/>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{agent.name.split(' ')[0]}</span>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, fontWeight: 700, color: T_D.colors.red, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Unassigned</span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{money(d.customerPrice)}</div>
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
// Needs Review queue
// ────────────────────────────────────────────────────────────
const NeedsReview = ({ deliveries, onBack, onOpen }) => {
  const list = deliveries.filter(d => d.needsReview || !d.agentId);
  return (
    <div style={{ background: T_D.colors.surface, minHeight: '100%' }}>
      <AppBar
        title="Needs review"
        subtitle={`${list.length} ${list.length === 1 ? 'item' : 'items'} need your attention`}
        left={onBack && <button onClick={onBack} style={{ background: 'transparent', border: 0, padding: 4, cursor: 'pointer' }}><Icon name="chevronLeft" size={26}/></button>}
      />
      <div style={{ padding: 16, paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {list.map(d => {
          const product = findProduct(d.productId);
          const reason = d.needsReview === 'address' ? "AI couldn't match address" : 'No agent assigned';
          return (
            <Card key={d.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ background: T_D.colors.warningSoft, color: '#92400E', padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="bot" size={12}/>
                  {reason}
                </div>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{d.customer}</div>
              <div style={{ fontSize: 13, color: T_D.colors.textSecondary, marginTop: 2 }}>
                {product?.name} × {d.qty} · {money(d.customerPrice)}
              </div>
              <div style={{ marginTop: 8, padding: 10, background: T_D.colors.surface, borderRadius: 10 }}>
                <div style={{ fontSize: 11, color: T_D.colors.textSecondary, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Raw address</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{d.rawAddress}</div>
                {d.botRaw && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T_D.colors.border}`, fontSize: 12, color: T_D.colors.textSecondary, fontStyle: 'italic', lineHeight: 1.5 }}>
                    "{d.botRaw}"
                  </div>
                )}
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm">Open</Button>
                <Button variant="primary" size="sm" iconRight="arrowRight" style={{ marginLeft: 'auto' }}>Assign location</Button>
              </div>
            </Card>
          );
        })}
        {list.length === 0 && <Empty icon="check" title="All clear" sub="No deliveries need review. Good work."/>}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Create Delivery sheet
// ────────────────────────────────────────────────────────────
const CreateDeliverySheet = ({ open, onClose, onCreate }) => {
  const [customer, setCustomer] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [client, setClient] = React.useState(null);
  const [product, setProduct] = React.useState(null);
  const [qty, setQty] = React.useState(1);
  const [price, setPrice] = React.useState('');

  const eligibleProducts = client ? D_D.products.filter(p => p.client === client) : [];

  return (
    <Sheet open={open} onClose={onClose} title="New delivery" subtitle="Manual creation">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
        <Input label="Customer name" value={customer} onChange={setCustomer} placeholder="Mr. Akoro"/>
        <Input label="Phone" value={phone} onChange={setPhone} icon="phone" placeholder="+234 805 …"/>
        <Input label="Address" value={address} onChange={setAddress} icon="mapPin" placeholder="17 Admiralty Way, Lekki" helper="AI will match to a known location"/>

        <div>
          <div style={{ fontSize: 12, color: T_D.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Client</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {D_D.clients.map(c => (
              <button key={c.id} onClick={() => { setClient(c.id); setProduct(null); }} style={{
                padding: '8px 12px', borderRadius: 999,
                background: client === c.id ? T_D.colors.black : T_D.colors.white,
                color: client === c.id ? '#FFFFFF' : T_D.colors.black,
                border: `1.5px solid ${client === c.id ? T_D.colors.black : T_D.colors.border}`,
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>{c.name}</button>
            ))}
          </div>
        </div>

        {client && (
          <div>
            <div style={{ fontSize: 12, color: T_D.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Product</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {eligibleProducts.map(p => (
                <button key={p.id} onClick={() => { setProduct(p.id); setPrice(p.price); }} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 14px', borderRadius: 12,
                  background: product === p.id ? T_D.colors.surface : 'transparent',
                  border: `1.5px solid ${product === p.id ? T_D.colors.black : T_D.colors.border}`,
                  cursor: 'pointer', fontFamily: T_D.font,
                }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 13, color: T_D.colors.textSecondary }}>{money(p.price)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 12 }}>
          <Input label="Qty" value={String(qty)} onChange={v => setQty(Number(v) || 1)}/>
          <Input label="Customer price (₦)" value={String(price)} onChange={v => setPrice(Number(v) || 0)}/>
        </div>

        <Banner tone="info" icon="bot">Agent will be auto-assigned based on location and stock.</Banner>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" full icon="check" onClick={onCreate}>Create delivery</Button>
        </div>
      </div>
    </Sheet>
  );
};

Object.assign(window, { DispatcherHome, DeliveriesList, NeedsReview, CreateDeliverySheet, FilterChips });
