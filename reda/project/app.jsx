// Main Reda app — router, login, role-specific shells, tweaks integration.

const T_APP = window.REDA_THEME;
const D_APP = window.REDA_DATA;

// ────────────────────────────────────────────────────────────
// Login screen
// ────────────────────────────────────────────────────────────
const Login = ({ onSignIn }) => {
  const [email, setEmail] = React.useState('uzo@reda.ng');
  const [password, setPassword] = React.useState('••••••••');
  const accounts = Object.values(D_APP.users).map(u => ({
    id: u.id, email: u.name.split(' ')[0].toLowerCase() + '@reda.ng', name: u.name, role: u.role, color: u.color, initials: u.initials,
  }));

  return (
    <div style={{
      background: T_APP.colors.black, color: '#FFFFFF', height: '100%',
      display: 'flex', flexDirection: 'column', fontFamily: T_APP.font,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Brand block */}
      <div style={{ padding: '60px 24px 32px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <RedaMark size={64} inverted/>
        <div style={{ marginTop: 24, fontSize: 32, fontWeight: 800, letterSpacing: '-0.025em', lineHeight: 1.1 }}>
          Fast. Reliable.<br/>
          <span style={{ color: T_APP.colors.red }}>Last mile, done right.</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 14, color: '#A3A3A3', maxWidth: 260, lineHeight: 1.5 }}>
          Reda internal team app — log in to manage today's deliveries.
        </div>
      </div>

      {/* Sign-in card */}
      <div style={{ background: T_APP.colors.white, color: T_APP.colors.black, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: '24px 20px 28px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T_APP.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
          Sign in
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="Email" value={email} onChange={setEmail} icon="user"/>
          <Input label="Password" value={password} onChange={setPassword} icon="settings" type="password" focused/>
        </div>
        <div style={{ marginTop: 18 }}>
          <Button variant="emphasis" full onClick={() => onSignIn('u-uzo')}>Sign in</Button>
        </div>

        {/* Demo account picker */}
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${T_APP.colors.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T_APP.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Demo · tap to sign in as
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { id: 'u-uzo',     role: 'Admin' },
              { id: 'u-amaka',   role: 'Dispatcher' },
              { id: 'u-kenneth', role: 'Agent' },
              { id: 'u-folake',  role: 'Warehouse' },
            ].map(a => {
              const u = D_APP.users[a.id];
              return (
                <button key={a.id} onClick={() => onSignIn(a.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                  border: `1px solid ${T_APP.colors.border}`, borderRadius: 12,
                  background: T_APP.colors.white, cursor: 'pointer',
                  textAlign: 'left', fontFamily: T_APP.font,
                }}>
                  <Avatar user={u} size={28}/>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name.split(' ')[0]}</div>
                    <div style={{ fontSize: 10, color: T_APP.colors.textSecondary }}>{a.role}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Role-specific tab definitions
// ────────────────────────────────────────────────────────────
const ROLE_TABS = {
  agent: [
    { id: 'home',     label: 'Today',    icon: 'home' },
    { id: 'stock',    label: 'My stock', icon: 'package' },
    { id: 'earnings', label: 'Earnings', icon: 'wallet' },
    { id: 'profile',  label: 'Profile',  icon: 'user' },
  ],
  dispatcher: [
    { id: 'home',       label: 'Dashboard',  icon: 'home' },
    { id: 'deliveries', label: 'Deliveries', icon: 'truck' },
    { id: 'review',     label: 'Review',     icon: 'alert' },
    { id: 'profile',    label: 'Profile',    icon: 'user' },
  ],
  admin: [
    { id: 'home',       label: 'Home',       icon: 'home' },
    { id: 'deliveries', label: 'Deliveries', icon: 'truck' },
    { id: 'recon',      label: 'Recon',      icon: 'wallet' },
    { id: 'eod',        label: 'End of day', icon: 'calendar' },
    { id: 'profile',    label: 'Profile',    icon: 'user' },
  ],
  warehouse: [
    { id: 'home',     label: 'Stock',    icon: 'warehouse' },
    { id: 'products', label: 'Products', icon: 'package' },
    { id: 'profile',  label: 'Profile',  icon: 'user' },
  ],
};

// ────────────────────────────────────────────────────────────
// Profile screen — common across roles
// ────────────────────────────────────────────────────────────
const Profile = ({ user, onLogout, onSwitchAccount }) => (
  <div style={{ background: T_APP.colors.surface, minHeight: '100%' }}>
    <AppBar title="Profile"/>
    <div style={{ padding: 16, paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar user={user} size={60}/>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>{user.name}</div>
            <div style={{ fontSize: 13, color: T_APP.colors.textSecondary, marginTop: 2, textTransform: 'capitalize' }}>{user.role}</div>
            <div style={{ fontSize: 12, color: T_APP.colors.textSecondary, marginTop: 2, fontFamily: T_APP.fontMono }}>{user.phone}</div>
          </div>
        </div>
      </Card>

      <Card style={{ padding: 0 }}>
        {[
          { label: 'Notifications', icon: 'bell', value: 'On' },
          { label: 'Language',      icon: 'settings', value: 'English (NG)' },
          { label: 'Help & support', icon: 'alert', value: '' },
          { label: 'About Reda',    icon: 'file', value: 'v1.0.0' },
        ].map((row, i, arr) => (
          <div key={i} style={{
            padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
            borderBottom: i < arr.length - 1 ? `1px solid ${T_APP.colors.border}` : 0,
          }}>
            <Icon name={row.icon} size={20} color={T_APP.colors.textSecondary}/>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{row.label}</div>
            <div style={{ fontSize: 13, color: T_APP.colors.textSecondary }}>{row.value}</div>
            <Icon name="chevronRight" size={16} color={T_APP.colors.textSecondary}/>
          </div>
        ))}
      </Card>

      <Button variant="destructive" full icon="logout" onClick={onLogout}>Log out</Button>
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────
// Tweak defaults
// ────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "role": "agent",
  "pillVariant": "filled",
  "density": "default",
  "darkAgentHeader": false,
  "strictBrand": false
}/*EDITMODE-END*/;

// ────────────────────────────────────────────────────────────
// Root App
// ────────────────────────────────────────────────────────────
const RedaApp = () => {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [userId, setUserId] = React.useState(null); // null = not signed in (Login screen)
  const [tab, setTab] = React.useState('home');
  const [route, setRoute] = React.useState({ name: 'tabs' });
  const [deliveryId, setDeliveryId] = React.useState(null);
  const [sheets, setSheets] = React.useState({});
  const [toast, setToast] = React.useState(null);

  // Show toast helper
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // Sync role from tweaks panel: change tweaks.role -> pick a user of that role
  React.useEffect(() => {
    if (!userId) return;
    const currentRole = D_APP.users[userId].role;
    if (currentRole !== tweaks.role) {
      const newUser = Object.values(D_APP.users).find(u => u.role === tweaks.role);
      if (newUser) {
        setUserId(newUser.id);
        setTab('home');
        setRoute({ name: 'tabs' });
      }
    }
  }, [tweaks.role]);

  const user = userId ? D_APP.users[userId] : null;
  const deliveries = D_APP.deliveries;

  const signIn = (uid) => {
    setUserId(uid);
    setTweak('role', D_APP.users[uid].role);
    setTab('home');
    setRoute({ name: 'tabs' });
  };

  const logout = () => { setUserId(null); setRoute({ name: 'tabs' }); };

  const openDelivery = (id) => { setDeliveryId(id); setRoute({ name: 'delivery' }); };
  const back = () => setRoute({ name: 'tabs' });

  const pillVariant = tweaks.strictBrand ? 'subtle' : tweaks.pillVariant;

  // ───── Render Login if not signed in
  if (!userId) {
    return (
      <>
        <Login onSignIn={signIn}/>
        <RedaTweaks tweaks={tweaks} setTweak={setTweak}/>
      </>
    );
  }

  // ───── Pick screen body based on role + tab + route
  let body = null;
  const role = user.role;
  const visibleDeliveries = role === 'agent'
    ? deliveries.filter(d => d.agentId === user.id)
    : deliveries;

  if (route.name === 'delivery') {
    const d = deliveries.find(x => x.id === deliveryId);
    body = (
      <AgentDeliveryDetail
        delivery={d}
        onBack={back}
        onMarkDelivered={() => setSheets({ mark: true })}
        onChangeStatus={() => setSheets({ status: true })}
        pillVariant={pillVariant}
      />
    );
  } else if (route.name === 'recon') {
    body = <Reconciliation onBack={back} deliveries={deliveries}/>;
  } else if (route.name === 'eod') {
    body = <EndOfDay onBack={back} deliveries={deliveries}/>;
  } else if (route.name === 'catalog') {
    body = <Catalog onBack={back}/>;
  } else if (route.name === 'review') {
    body = <NeedsReview onBack={back} deliveries={deliveries} onOpen={openDelivery}/>;
  } else {
    // Tab body
    if (role === 'agent') {
      if (tab === 'home')     body = <AgentHome user={user} deliveries={deliveries} onOpen={openDelivery} pillVariant={pillVariant} dark={tweaks.darkAgentHeader} density={tweaks.density}/>;
      if (tab === 'stock')    body = <AgentStock user={user}/>;
      if (tab === 'earnings') body = <AgentEarnings user={user} deliveries={deliveries}/>;
      if (tab === 'profile')  body = <Profile user={user} onLogout={logout}/>;
    } else if (role === 'dispatcher') {
      if (tab === 'home')       body = <DispatcherHome user={user} deliveries={deliveries} onOpen={openDelivery} onCreate={() => setSheets({ create: true })} onNeedsReview={() => setRoute({ name: 'review' })}/>;
      if (tab === 'deliveries') body = <DeliveriesList deliveries={deliveries} onOpen={openDelivery}/>;
      if (tab === 'review')     body = <NeedsReview deliveries={deliveries} onOpen={openDelivery}/>;
      if (tab === 'profile')    body = <Profile user={user} onLogout={logout}/>;
    } else if (role === 'admin') {
      if (tab === 'home')       body = <AdminHome user={user} deliveries={deliveries} onCreate={() => setSheets({ create: true })} onEOD={() => setRoute({ name: 'eod' })} onRecon={() => setRoute({ name: 'recon' })} onReview={() => setRoute({ name: 'review' })} onCatalog={() => setRoute({ name: 'catalog' })} onOpenDelivery={openDelivery}/>;
      if (tab === 'deliveries') body = <DeliveriesList deliveries={deliveries} onOpen={openDelivery}/>;
      if (tab === 'recon')      body = <Reconciliation deliveries={deliveries}/>;
      if (tab === 'eod')        body = <EndOfDay deliveries={deliveries}/>;
      if (tab === 'profile')    body = <Profile user={user} onLogout={logout}/>;
    } else if (role === 'warehouse') {
      if (tab === 'home')     body = <WarehouseHome onAdjust={() => setSheets({ adjust: true })}/>;
      if (tab === 'products') body = <Catalog/>;
      if (tab === 'profile')  body = <Profile user={user} onLogout={logout}/>;
    }
  }

  const showTabBar = route.name === 'tabs';

  return (
    <>
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        background: T_APP.colors.surface, position: 'relative',
        fontFamily: T_APP.font,
      }}>
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          {body}
          <Toast visible={!!toast}>{toast}</Toast>
        </div>
        {showTabBar && (
          <TabBar
            tabs={ROLE_TABS[role]}
            value={tab}
            onChange={setTab}
          />
        )}
      </div>

      {/* Sheets */}
      <MarkDeliveredSheet
        open={!!sheets.mark}
        delivery={deliveries.find(d => d.id === deliveryId)}
        onClose={() => setSheets({})}
        onConfirm={(v) => {
          setSheets({});
          showToast(`Delivered. ${money(v.paid)} recorded.`);
          setTimeout(() => back(), 600);
        }}
      />
      <UpdateStatusSheet
        open={!!sheets.status}
        delivery={deliveries.find(d => d.id === deliveryId)}
        onClose={() => setSheets({})}
        onPick={(s) => {
          setSheets({});
          showToast(`Status updated to ${T_APP.status[s].label.toLowerCase()}.`);
        }}
      />
      <CreateDeliverySheet
        open={!!sheets.create}
        onClose={() => setSheets({})}
        onCreate={() => { setSheets({}); showToast('Delivery created and assigned.'); }}
      />
      <AdjustmentSheet
        open={!!sheets.adjust}
        onClose={() => setSheets({})}
        onConfirm={() => { setSheets({}); showToast('Stock adjustment saved.'); }}
      />

      <RedaTweaks tweaks={tweaks} setTweak={setTweak}/>
    </>
  );
};

// ────────────────────────────────────────────────────────────
// Tweaks Panel
// ────────────────────────────────────────────────────────────
const RedaTweaks = ({ tweaks, setTweak }) => (
  <TweaksPanel title="Tweaks">
    <TweakSection label="Sign in as">
      <TweakSelect
        label="Role"
        value={tweaks.role}
        onChange={v => setTweak('role', v)}
        options={[
          { value: 'agent', label: 'Agent (Kenneth)' },
          { value: 'dispatcher', label: 'Dispatcher (Amaka)' },
          { value: 'admin', label: 'Admin (Uzo)' },
          { value: 'warehouse', label: 'Warehouse (Folake)' },
        ]}
      />
    </TweakSection>

    <TweakSection label="Visual style">
      <TweakRadio
        label="Status pills"
        value={tweaks.pillVariant}
        onChange={v => setTweak('pillVariant', v)}
        options={[
          { value: 'filled', label: 'Filled' },
          { value: 'subtle', label: 'Subtle' },
        ]}
      />
      <TweakRadio
        label="Density"
        value={tweaks.density}
        onChange={v => setTweak('density', v)}
        options={[
          { value: 'default', label: 'Default' },
          { value: 'compact', label: 'Compact' },
        ]}
      />
      <TweakToggle
        label="Dark agent header"
        value={tweaks.darkAgentHeader}
        onChange={v => setTweak('darkAgentHeader', v)}
      />
      <TweakToggle
        label="Strict brand (no green)"
        value={tweaks.strictBrand}
        onChange={v => setTweak('strictBrand', v)}
      />
    </TweakSection>
  </TweaksPanel>
);

// ────────────────────────────────────────────────────────────
// Mount
// ────────────────────────────────────────────────────────────
function MountedApp() {
  return (
    <div style={{
      width: '100%', minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#1a1a1a',
      padding: 20, boxSizing: 'border-box',
      fontFamily: T_APP.font,
    }}>
      <AndroidDevice width={412} height={892}>
        <RedaApp/>
      </AndroidDevice>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<MountedApp/>);
