// Admin screens — Uzo's flow.
const T_AD = window.REDA_THEME;
const D_AD = window.REDA_DATA;

// ────────────────────────────────────────────────────────────
// Admin Home
// ────────────────────────────────────────────────────────────
const AdminHome = ({ user, deliveries, onCreate, onEOD, onRecon, onReview, onCatalog, onOpenDelivery }) => {
  const total = deliveries.length;
  const delivered = deliveries.filter(d => d.status === 'delivered');
  const grossVolume = deliveries.reduce((s, d) => s + d.customerPrice, 0);
  const remit = delivered.reduce((s, d) => s + (d.paid - d.charged), 0);
  const margin = delivered.reduce((s, d) => s + (d.charged - d.agentPayment), 0);
  const needsReview = deliveries.filter(d => d.needsReview || !d.agentId);
  const stale = deliveries.filter(d => statusBucket(d.status) === 'soft');

  return (
    <div style={{ background: T_AD.colors.surface, minHeight: '100%', paddingBottom: 100 }}>
      <AppBar
        title={`Hi, ${user.name.split(' ')[0]}`}
        subtitle="Wed, May 13 · Admin"
        right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="settings" size={20}/></button>}
      />

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Today's numbers, hero card */}
        <Card style={{ background: T_AD.colors.black, color: '#FFFFFF', padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 11, color: '#A3A3A3', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Today's gross</div>
            <div style={{ fontSize: 11, color: '#A3A3A3', fontWeight: 500 }}>{delivered.length}/{total} delivered</div>
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.025em', marginTop: 4 }}>{money(grossVolume)}</div>

          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#222', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ background: T_AD.colors.black, padding: 12 }}>
              <div style={{ fontSize: 10, color: '#A3A3A3', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Remit collected</div>
              <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{money(remit)}</div>
            </div>
            <div style={{ background: T_AD.colors.black, padding: 12 }}>
              <div style={{ fontSize: 10, color: '#A3A3A3', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Margin</div>
              <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: T_AD.colors.red }}>{money(margin)}</div>
            </div>
          </div>
        </Card>

        {/* Needs attention */}
        <SectionHeader>Needs attention</SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {needsReview.length > 0 && (
            <Card onClick={onReview} dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 20, background: T_AD.colors.redSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="alert" size={18} color={T_AD.colors.red}/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{needsReview.length} {needsReview.length === 1 ? 'item needs' : 'items need'} review</div>
                  <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>Unmatched addresses or unassigned</div>
                </div>
                <Icon name="chevronRight" size={20} color={T_AD.colors.textSecondary}/>
              </div>
            </Card>
          )}
          {stale.length > 0 && (
            <Card dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 20, background: T_AD.colors.warningSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="history" size={18} color="#92400E"/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{stale.length} soft-failed today</div>
                  <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>Customer unreachable or rescheduled</div>
                </div>
                <Icon name="chevronRight" size={20} color={T_AD.colors.textSecondary}/>
              </div>
            </Card>
          )}
        </div>

        {/* Quick actions */}
        <SectionHeader>Quick actions</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { icon: 'plus', label: 'New delivery', onClick: onCreate, accent: T_AD.colors.red },
            { icon: 'wallet', label: 'Reconciliation', onClick: onRecon, accent: T_AD.colors.black },
            { icon: 'calendar', label: 'End of day', onClick: onEOD, accent: T_AD.colors.black },
            { icon: 'box', label: 'Catalog', onClick: onCatalog, accent: T_AD.colors.black },
          ].map((a, i) => (
            <Card key={i} onClick={a.onClick} dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: T_AD.colors.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={a.icon} size={18} color={a.accent}/>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{a.label}</div>
              </div>
            </Card>
          ))}
        </div>

        {/* Recent activity */}
        <SectionHeader right={<button style={{ background: 'transparent', border: 0, color: T_AD.colors.textSecondary, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>See all →</button>}>
          Recent activity
        </SectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {deliveries.slice(0, 4).map(d => (
            <Card key={d.id} dense onClick={() => onOpenDelivery?.(d.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{d.customer}</span>
                    <StatusPill status={d.status} variant="subtle" size="sm"/>
                  </div>
                  <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>
                    {findProduct(d.productId)?.name} · {d.agentId ? findUser(d.agentId).name.split(' ')[0] : 'Unassigned'}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{money(d.customerPrice)}</div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Reconciliation
// ────────────────────────────────────────────────────────────
const Reconciliation = ({ onBack, deliveries }) => {
  const [tab, setTab] = React.useState('client');
  const [range, setRange] = React.useState('week');

  const delivered = deliveries.filter(d => d.status === 'delivered');

  // Augment with synthetic week data for realism
  const synth = (extra) => extra.map(e => ({ ...e, _synth: true }));
  const weekDeliveries = [...delivered, ...synth([
    { clientId: 'c-dentora', agentId: 'u-kenneth', charged: 2500, agentPayment: 1200, paid: 19000, customerPrice: 19000, productId: 'p-d-tooth' },
    { clientId: 'c-dentora', agentId: 'u-tunde',   charged: 3000, agentPayment: 1500, paid: 19000, customerPrice: 19000, productId: 'p-d-tooth' },
    { clientId: 'c-omolewa', agentId: 'u-kenneth', charged: 2500, agentPayment: 1200, paid: 145000, customerPrice: 145000, productId: 'p-o-bone' },
    { clientId: 'c-omolewa', agentId: 'u-blessing',charged: 3500, agentPayment: 1800, paid: 95000, customerPrice: 95000, productId: 'p-o-curly' },
    { clientId: 'c-bareek',  agentId: 'u-ifeanyi', charged: 2500, agentPayment: 1200, paid: 32000, customerPrice: 32000, productId: 'p-b-bag' },
    { clientId: 'c-vitalix', agentId: 'u-tunde',   charged: 3500, agentPayment: 1800, paid: 31000, customerPrice: 31000, productId: 'p-v-multi' }, // overpay
    { clientId: 'c-vitalix', agentId: 'u-segun',   charged: 3000, agentPayment: 1500, paid: 24000, customerPrice: 24000, productId: 'p-v-c' },
    { clientId: 'c-dentora', agentId: 'u-segun',   charged: 3000, agentPayment: 1500, paid: 17000, customerPrice: 17000, productId: 'p-d-floss' },
  ])];

  // Group by client or agent
  const groupKey = tab === 'client' ? 'clientId' : 'agentId';
  const groups = {};
  weekDeliveries.forEach(d => {
    const k = d[groupKey];
    if (!groups[k]) groups[k] = { items: [], totalRemit: 0, totalEarnings: 0, totalGross: 0, count: 0 };
    groups[k].items.push(d);
    groups[k].totalRemit += (d.paid - d.charged);
    groups[k].totalEarnings += d.agentPayment;
    groups[k].totalGross += d.paid;
    groups[k].count += 1;
  });
  const sortedGroups = Object.entries(groups).sort((a, b) => b[1].totalGross - a[1].totalGross);

  const grandRemit = weekDeliveries.reduce((s, d) => s + (d.paid - d.charged), 0);
  const grandEarnings = weekDeliveries.reduce((s, d) => s + d.agentPayment, 0);

  const [openId, setOpenId] = React.useState(null);

  return (
    <div style={{ background: T_AD.colors.surface, minHeight: '100%' }}>
      <AppBar
        left={<button onClick={onBack} style={{ background: 'transparent', border: 0, padding: 4, cursor: 'pointer' }}><Icon name="chevronLeft" size={26}/></button>}
        title="Reconciliation"
        subtitle="This week · May 10 – 13"
      />

      {/* Tabs */}
      <div style={{ background: T_AD.colors.white, padding: '0 16px', borderBottom: `1px solid ${T_AD.colors.border}`, display: 'flex', gap: 24 }}>
        {[
          { id: 'client', label: 'By client' },
          { id: 'agent', label: 'By agent' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'transparent', border: 0, padding: '14px 0', cursor: 'pointer',
            fontFamily: T_AD.font, fontSize: 14, fontWeight: 700,
            color: tab === t.id ? T_AD.colors.black : T_AD.colors.textSecondary,
            borderBottom: `2px solid ${tab === t.id ? T_AD.colors.red : 'transparent'}`,
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Big total */}
      <div style={{ padding: '16px 16px 8px' }}>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: T_AD.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {tab === 'client' ? 'Total remit owed' : 'Total earnings owed'}
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.025em', marginTop: 4, color: tab === 'client' ? T_AD.colors.black : T_AD.colors.success }}>
            {money(tab === 'client' ? grandRemit : grandEarnings)}
          </div>
          <div style={{ fontSize: 13, color: T_AD.colors.textSecondary, marginTop: 2 }}>
            {weekDeliveries.length} deliveries · {sortedGroups.length} {tab === 'client' ? 'clients' : 'agents'}
          </div>
        </Card>
      </div>

      <div style={{ padding: '8px 16px 100px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortedGroups.map(([key, g]) => {
          const subject = tab === 'client' ? findClient(key) : findUser(key);
          const isOpen = openId === key;
          return (
            <Card key={key} dense style={{ padding: 0 }}>
              <button onClick={() => setOpenId(isOpen ? null : key)} style={{
                width: '100%', background: 'transparent', border: 0, padding: 14,
                display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                textAlign: 'left',
              }}>
                {tab === 'agent' && <Avatar user={subject} size={36}/>}
                {tab === 'client' && (
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: T_AD.colors.black, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T_AD.font, fontWeight: 800, fontSize: 14 }}>
                    {subject.name[0]}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{subject.name}</div>
                  <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>{g.count} deliveries · {money(g.totalGross)} gross</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em', color: tab === 'client' ? T_AD.colors.black : T_AD.colors.success }}>
                    {money(tab === 'client' ? g.totalRemit : g.totalEarnings)}
                  </div>
                  <div style={{ fontSize: 10, color: T_AD.colors.textSecondary, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
                    {tab === 'client' ? 'Remit' : 'Earnings'}
                  </div>
                </div>
                <div style={{ marginLeft: 4, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 200ms' }}>
                  <Icon name="chevronRight" size={18} color={T_AD.colors.textSecondary}/>
                </div>
              </button>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${T_AD.colors.border}`, background: T_AD.colors.surfaceAlt }}>
                  {g.items.map((d, i) => {
                    const otherSubj = tab === 'client' ? (d.agentId ? findUser(d.agentId) : null) : findClient(d.clientId);
                    const value = tab === 'client' ? (d.paid - d.charged) : d.agentPayment;
                    return (
                      <div key={i} style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: i < g.items.length - 1 ? `1px solid ${T_AD.colors.border}` : 0 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{findProduct(d.productId)?.name || d.customer}</div>
                          <div style={{ fontSize: 11, color: T_AD.colors.textSecondary, marginTop: 2 }}>
                            {otherSubj?.name || '—'}
                          </div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{money(value)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// End of Day rollover
// ────────────────────────────────────────────────────────────
const EndOfDay = ({ onBack, deliveries }) => {
  const unfinished = deliveries.filter(d => !['delivered','cancelled','failed','unserious','no_product','rolled_over'].includes(d.status));
  const [decisions, setDecisions] = React.useState({});

  return (
    <div style={{ background: T_AD.colors.surface, minHeight: '100%' }}>
      <AppBar
        left={<button onClick={onBack} style={{ background: 'transparent', border: 0, padding: 4, cursor: 'pointer' }}><Icon name="chevronLeft" size={26}/></button>}
        title="End of day"
        subtitle="Decide what to do with unfinished deliveries"
      />
      {unfinished.length === 0 ? (
        <Empty icon="check" title="No deliveries today. Rest up." sub="Everything closed out cleanly."/>
      ) : (
        <>
          <div style={{ padding: 16 }}>
            <Banner tone="info" icon="calendar">
              <strong>{unfinished.length} {unfinished.length === 1 ? 'delivery' : 'deliveries'}</strong> still open.
              Pick an action for each, then confirm the batch.
            </Banner>
          </div>
          <div style={{ padding: '0 16px 100px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {unfinished.map(d => {
              const product = findProduct(d.productId);
              const agent = d.agentId ? findUser(d.agentId) : null;
              const decision = decisions[d.id];
              return (
                <Card key={d.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{d.customer}</div>
                      <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>
                        {product?.name} × {d.qty} · {money(d.customerPrice)}
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <StatusPill status={d.status} variant="subtle" size="sm"/>
                        {agent && <span style={{ fontSize: 12, color: T_AD.colors.textSecondary }}>· {agent.name.split(' ')[0]}</span>}
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                    {[
                      { id: 'rollover_same', label: 'Roll over', sub: 'same agent', icon: 'arrowRight' },
                      { id: 'rollover_warehouse', label: 'Return', sub: 'to warehouse', icon: 'warehouse' },
                      { id: 'cancel', label: 'Cancel', sub: 'close out', icon: 'x' },
                    ].map(opt => {
                      const active = decision === opt.id;
                      const danger = opt.id === 'cancel' && active;
                      return (
                        <button key={opt.id}
                          onClick={() => setDecisions({ ...decisions, [d.id]: opt.id })}
                          style={{
                            padding: 10, border: `1.5px solid ${active ? (danger ? T_AD.colors.red : T_AD.colors.black) : T_AD.colors.border}`,
                            background: active ? (danger ? T_AD.colors.redSoft : T_AD.colors.surface) : T_AD.colors.white,
                            borderRadius: 10, cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                            fontFamily: T_AD.font,
                          }}>
                          <Icon name={opt.icon} size={14} color={active ? (danger ? T_AD.colors.red : T_AD.colors.black) : T_AD.colors.textSecondary}/>
                          <div style={{ fontSize: 12, fontWeight: 700, color: danger ? T_AD.colors.red : T_AD.colors.black }}>{opt.label}</div>
                          <div style={{ fontSize: 10, color: T_AD.colors.textSecondary }}>{opt.sub}</div>
                        </button>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
          {/* Sticky bottom confirm */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            padding: '12px 16px 16px', background: T_AD.colors.white,
            borderTop: `1px solid ${T_AD.colors.border}`,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, fontWeight: 600 }}>{Object.keys(decisions).length}/{unfinished.length} decided</div>
            </div>
            <Button variant="emphasis" icon="check" disabled={Object.keys(decisions).length < unfinished.length}>Confirm all</Button>
          </div>
        </>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Catalog
// ────────────────────────────────────────────────────────────
const Catalog = ({ onBack }) => {
  const [tab, setTab] = React.useState('clients');
  return (
    <div style={{ background: T_AD.colors.surface, minHeight: '100%' }}>
      <AppBar
        left={<button onClick={onBack} style={{ background: 'transparent', border: 0, padding: 4, cursor: 'pointer' }}><Icon name="chevronLeft" size={26}/></button>}
        title="Catalog"
        subtitle={`${D_AD.clients.length} clients · ${D_AD.products.length} products · ${D_AD.locations.length} locations`}
      />
      <div style={{ background: T_AD.colors.white, padding: '0 16px', borderBottom: `1px solid ${T_AD.colors.border}`, display: 'flex', gap: 20 }}>
        {[
          { id: 'clients',   label: 'Clients' },
          { id: 'products',  label: 'Products' },
          { id: 'locations', label: 'Locations' },
          { id: 'users',     label: 'Users' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'transparent', border: 0, padding: '14px 0', cursor: 'pointer',
            fontFamily: T_AD.font, fontSize: 13, fontWeight: 700,
            color: tab === t.id ? T_AD.colors.black : T_AD.colors.textSecondary,
            borderBottom: `2px solid ${tab === t.id ? T_AD.colors.red : 'transparent'}`,
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: 16, paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tab === 'clients' && D_AD.clients.map(c => (
          <Card key={c.id} dense>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: T_AD.colors.black, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T_AD.font, fontWeight: 800 }}>
                {c.name[0]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>{c.contact} · {c.activeProducts} products</div>
              </div>
              <Icon name="chevronRight" size={18} color={T_AD.colors.textSecondary}/>
            </div>
            {c.notes && (
              <div style={{ marginTop: 10, padding: 10, background: T_AD.colors.warningSoft, borderRadius: 8, fontSize: 12, color: '#78350F', fontWeight: 600, lineHeight: 1.5 }}>
                {c.notes}
              </div>
            )}
          </Card>
        ))}
        {tab === 'products' && D_AD.products.map(p => {
          const c = findClient(p.client);
          return (
            <Card key={p.id} dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: T_AD.colors.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="package" size={18}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2 }}>{c?.name}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{money(p.price)}</div>
              </div>
            </Card>
          );
        })}
        {tab === 'locations' && (
          <>
            <div style={{ padding: '6px 4px 10px', fontSize: 12, color: T_AD.colors.textSecondary, display: 'grid', gridTemplateColumns: '1fr 70px 70px', gap: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <div>Location</div>
              <div style={{ textAlign: 'right' }}>Charged</div>
              <div style={{ textAlign: 'right' }}>Agent</div>
            </div>
            {D_AD.locations.map(l => (
              <Card key={l.id} dense style={{ padding: '10px 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px', gap: 8, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{l.name}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, fontFamily: T_AD.fontMono }}>₦{l.rate.charged.toLocaleString()}</div>
                  <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, fontFamily: T_AD.fontMono, color: T_AD.colors.textSecondary }}>₦{l.rate.agent.toLocaleString()}</div>
                </div>
              </Card>
            ))}
          </>
        )}
        {tab === 'users' && Object.values(D_AD.users).map(u => (
          <Card key={u.id} dense>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar user={u}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{u.name}</div>
                <div style={{ fontSize: 12, color: T_AD.colors.textSecondary, marginTop: 2, fontFamily: T_AD.fontMono }}>{u.phone}</div>
              </div>
              <div style={{ background: T_AD.colors.surface, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: T_AD.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {u.role}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { AdminHome, Reconciliation, EndOfDay, Catalog });
