// Warehouse screens — Folake's flow.
const T_W = window.REDA_THEME;
const D_W = window.REDA_DATA;

// ────────────────────────────────────────────────────────────
// Warehouse Home — Stock by agent (and warehouse)
// ────────────────────────────────────────────────────────────
const WarehouseHome = ({ onAdjust, onTransfer }) => {
  const agents = Object.values(D_W.users).filter(u => u.role === 'agent' || u.role === 'warehouse');
  // Aggregate stock per agent
  const stockByAgent = {};
  D_W.stock.forEach(s => {
    const k = s.agentId === 'warehouse' ? 'warehouse' : s.agentId;
    if (!stockByAgent[k]) stockByAgent[k] = { items: [], total: 0 };
    stockByAgent[k].items.push(s);
    stockByAgent[k].total += s.qty;
  });

  const warehouseEntry = { id: 'warehouse', name: 'Warehouse', initials: 'WH', color: '#0A0A0A', role: 'warehouse' };
  const agentList = [warehouseEntry, ...agents.filter(a => a.role === 'agent')];

  return (
    <div style={{ background: T_W.colors.surface, minHeight: '100%', paddingBottom: 100 }}>
      <AppBar
        title="Stock"
        subtitle="Warehouse + 5 agents"
        right={<button style={{ background: 'transparent', border: 0, padding: 8, cursor: 'pointer' }}><Icon name="search" size={20}/></button>}
      />

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agentList.map(a => {
          const data = stockByAgent[a.id] || { items: [], total: 0 };
          const isWh = a.id === 'warehouse';
          const lowItems = data.items.filter(i => i.qty <= 3).length;
          return (
            <Card key={a.id} dense>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {isWh ? (
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: T_W.colors.black, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="warehouse" size={22}/>
                  </div>
                ) : (
                  <Avatar user={a} size={44}/>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: T_W.colors.textSecondary, marginTop: 2 }}>
                    {data.items.length} products · {data.total} items {lowItems > 0 && <span style={{ color: T_W.colors.red, fontWeight: 700 }}>· {lowItems} low</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>{data.total}</div>
                  <Icon name="chevronRight" size={18} color={T_W.colors.textSecondary}/>
                </div>
              </div>
              {/* Tiny per-product preview */}
              <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {data.items.slice(0, 6).map(i => {
                  const p = findProduct(i.productId);
                  const low = i.qty <= 3;
                  return (
                    <div key={i.productId} style={{
                      padding: '4px 8px', background: low ? T_W.colors.redSoft : T_W.colors.surface,
                      border: low ? `1px solid #FCA5A5` : `1px solid ${T_W.colors.border}`,
                      borderRadius: 999, fontSize: 11, fontFamily: T_W.font,
                      display: 'flex', alignItems: 'center', gap: 4,
                      color: low ? T_W.colors.red : T_W.colors.textSecondary,
                    }}>
                      <span style={{ fontWeight: 600 }}>{p?.name.split(' ').slice(0, 2).join(' ')}</span>
                      <span style={{ fontWeight: 800, color: low ? T_W.colors.red : T_W.colors.black }}>{i.qty}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>

      <FAB icon="plus" label="Adjust" onClick={onAdjust}/>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Stock Adjustment sheet
// ────────────────────────────────────────────────────────────
const AdjustmentSheet = ({ open, onClose, onConfirm }) => {
  const [agent, setAgent] = React.useState('warehouse');
  const [product, setProduct] = React.useState(null);
  const [delta, setDelta] = React.useState(1);
  const [reason, setReason] = React.useState('restock');

  const reasons = [
    { id: 'restock',     label: 'Restock',      icon: 'arrowDown',  desc: 'New inventory received' },
    { id: 'transfer',    label: 'Transfer',     icon: 'arrowRight', desc: 'Between agents / warehouse' },
    { id: 'damaged',     label: 'Damaged',      icon: 'alert',      desc: 'Write off damaged stock' },
    { id: 'lost',        label: 'Lost',         icon: 'x',          desc: 'Lost or stolen' },
    { id: 'correction',  label: 'Correction',   icon: 'edit',       desc: 'Fix prior data entry' },
    { id: 'return',      label: 'Customer return', icon: 'arrowUp', desc: 'Customer returned the item' },
  ];

  return (
    <Sheet open={open} onClose={onClose} title="Stock adjustment" subtitle="Record a change in stock">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 24 }}>
        {/* Agent */}
        <div>
          <div style={{ fontSize: 12, color: T_W.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Agent or warehouse</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[{ id: 'warehouse', name: 'Warehouse', initials: 'WH', color: T_W.colors.black, role: 'warehouse' }, ...Object.values(D_W.users).filter(u => u.role === 'agent')].map(a => {
              const active = agent === a.id;
              return (
                <button key={a.id} onClick={() => setAgent(a.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px 6px 6px', borderRadius: 999,
                  background: active ? T_W.colors.black : T_W.colors.white,
                  border: `1.5px solid ${active ? T_W.colors.black : T_W.colors.border}`,
                  color: active ? '#FFFFFF' : T_W.colors.black,
                  cursor: 'pointer', fontFamily: T_W.font, fontWeight: 600, fontSize: 13,
                }}>
                  <Avatar user={a} size={24}/>
                  {a.name.split(' ')[0]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Product */}
        <div>
          <div style={{ fontSize: 12, color: T_W.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Product</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {D_W.products.slice(0, 5).map(p => {
              const c = findClient(p.client);
              return (
                <button key={p.id} onClick={() => setProduct(p.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 14px', borderRadius: 12,
                  background: product === p.id ? T_W.colors.surface : 'transparent',
                  border: `1.5px solid ${product === p.id ? T_W.colors.black : T_W.colors.border}`,
                  cursor: 'pointer', fontFamily: T_W.font, textAlign: 'left',
                }}>
                  <Icon name="package" size={16} color={T_W.colors.textSecondary}/>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: T_W.colors.textSecondary, marginTop: 2 }}>{c?.name}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Delta stepper */}
        <div>
          <div style={{ fontSize: 12, color: T_W.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Quantity change</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: T_W.colors.surface, borderRadius: 14, padding: 8 }}>
            <button onClick={() => setDelta(d => d - 1)} style={{ width: 44, height: 44, borderRadius: 22, background: T_W.colors.white, border: `1.5px solid ${T_W.colors.border}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" size={18}/>
            </button>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em', color: delta > 0 ? T_W.colors.success : delta < 0 ? T_W.colors.red : T_W.colors.black }}>
                {delta > 0 ? '+' : ''}{delta}
              </div>
              <div style={{ fontSize: 11, color: T_W.colors.textSecondary, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>units</div>
            </div>
            <button onClick={() => setDelta(d => d + 1)} style={{ width: 44, height: 44, borderRadius: 22, background: T_W.colors.white, border: `1.5px solid ${T_W.colors.border}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" size={18}/>
            </button>
          </div>
        </div>

        {/* Reason */}
        <div>
          <div style={{ fontSize: 12, color: T_W.colors.textSecondary, fontWeight: 600, marginBottom: 8 }}>Reason</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {reasons.map(r => {
              const active = reason === r.id;
              return (
                <button key={r.id} onClick={() => setReason(r.id)} style={{
                  padding: 12, border: `1.5px solid ${active ? T_W.colors.black : T_W.colors.border}`,
                  background: active ? T_W.colors.surface : T_W.colors.white,
                  borderRadius: 12, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                  fontFamily: T_W.font, textAlign: 'left',
                }}>
                  <Icon name={r.icon} size={14}/>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{r.label}</div>
                  <div style={{ fontSize: 10, color: T_W.colors.textSecondary }}>{r.desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" full icon="check" onClick={onConfirm}>Save adjustment</Button>
        </div>
      </div>
    </Sheet>
  );
};

Object.assign(window, { WarehouseHome, AdjustmentSheet });
