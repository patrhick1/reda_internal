// Reda shared components — primitives used across role flows.
// Depends on window.REDA_THEME.

const T = window.REDA_THEME;

// ───────────────────────────────────────────────────────────
// Icons (minimal Lucide-style SVGs)
// ───────────────────────────────────────────────────────────
const Icon = ({ name, size = 20, color = 'currentColor', stroke = 2 }) => {
  const paths = {
    home:        <><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/></>,
    package:     <><path d="m12 3 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v9"/></>,
    truck:       <><path d="M3 6h13v10H3z"/><path d="M16 9h4l1 3v4h-5"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>,
    wallet:      <><path d="M3 7h16a2 2 0 0 1 2 2v9H3z"/><path d="M3 7V5h14v2"/><circle cx="17" cy="13" r="1"/></>,
    user:        <><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></>,
    users:       <><circle cx="9" cy="8" r="3.5"/><path d="M3 21c0-4 3-6 6-6s6 2 6 6"/><path d="M16 5a3 3 0 0 1 0 6"/><path d="M21 21c0-3-2-5-5-5"/></>,
    phone:       <><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></>,
    mapPin:      <><path d="M12 22s8-7 8-13a8 8 0 1 0-16 0c0 6 8 13 8 13z"/><circle cx="12" cy="9" r="3"/></>,
    chevronRight:<><path d="m9 6 6 6-6 6"/></>,
    chevronLeft: <><path d="m15 6-6 6 6 6"/></>,
    chevronDown: <><path d="m6 9 6 6 6-6"/></>,
    plus:        <><path d="M12 5v14M5 12h14"/></>,
    check:       <><path d="m5 12 5 5 9-11"/></>,
    x:           <><path d="m6 6 12 12M6 18 18 6"/></>,
    alert:       <><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".5"/><path d="m12 2 10 18H2z"/></>,
    bell:        <><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
    search:      <><circle cx="11" cy="11" r="7"/><path d="m21 21-4.5-4.5"/></>,
    filter:      <><path d="M3 5h18l-7 8v6l-4-2v-4z"/></>,
    refresh:     <><path d="M4 12a8 8 0 0 1 14-5l3-3v6h-6"/><path d="M20 12a8 8 0 0 1-14 5l-3 3v-6h6"/></>,
    settings:    <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h.1a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
    file:        <><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></>,
    calendar:    <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></>,
    warehouse:   <><path d="M3 9 12 4l9 5v11H3z"/><path d="M3 14h18M8 20v-6h8v6"/></>,
    arrowRight:  <><path d="M5 12h14M13 5l7 7-7 7"/></>,
    arrowDown:   <><path d="M12 5v14M5 13l7 7 7-7"/></>,
    arrowUp:     <><path d="M12 19V5M5 11l7-7 7 7"/></>,
    cash:        <><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></>,
    bank:        <><path d="M3 21h18M5 21V10M19 21V10M9 21v-7M15 21v-7M12 3 3 9h18z"/></>,
    history:     <><path d="M4 12a8 8 0 1 0 3-6"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/></>,
    bot:         <><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 3v5M8 12v2M16 12v2"/></>,
    eye:         <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
    box:         <><path d="m12 3 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v9"/></>,
    moreVertical:<><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></>,
    edit:        <><path d="M4 20h4l11-11-4-4L4 16z"/></>,
    sliders:     <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></>,
    logout:      <><path d="M9 4H5v16h4"/><path d="m15 8 4 4-4 4M19 12H9"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {paths[name]}
    </svg>
  );
};

// ───────────────────────────────────────────────────────────
// R-cube logomark — geometric placeholder for Reda's logo
// ───────────────────────────────────────────────────────────
const RedaMark = ({ size = 32, inverted = false }) => {
  const bg = inverted ? '#FFFFFF' : T.colors.black;
  const fg = inverted ? T.colors.black : '#FFFFFF';
  const accent = T.colors.red;
  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <rect x="2" y="2" width="28" height="28" rx="4" fill={bg}/>
        {/* R shape with arrow cutout suggestion */}
        <path d="M9 8h10a5 5 0 0 1 0 10h-3l5 6h-4l-5-6h-1v6H9z" fill={fg}/>
        <path d="M22 22l3-2-3-2z" fill={accent}/>
      </svg>
    </div>
  );
};

const RedaWordmark = ({ size = 22, inverted = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <RedaMark size={size + 6} inverted={inverted} />
    <span style={{
      fontFamily: T.font, fontWeight: 800, fontSize: size,
      letterSpacing: '-0.02em', color: inverted ? '#FFFFFF' : T.colors.black,
    }}>Reda</span>
  </div>
);

// ───────────────────────────────────────────────────────────
// AppBar (Reda-branded, replaces android default)
// ───────────────────────────────────────────────────────────
const AppBar = ({ title, subtitle, left, right, dark = false, sticky = true }) => (
  <div style={{
    background: dark ? T.colors.black : T.colors.white,
    color: dark ? T.colors.white : T.colors.black,
    borderBottom: `1px solid ${dark ? '#222' : T.colors.border}`,
    padding: '12px 16px',
    display: 'flex', alignItems: 'center', gap: 12, minHeight: 56,
    position: sticky ? 'sticky' : 'relative', top: 0, zIndex: 10,
    fontFamily: T.font,
  }}>
    {left || <RedaMark size={28} inverted={dark} />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: dark ? '#A3A3A3' : T.colors.textSecondary, marginTop: 1 }}>{subtitle}</div>}
    </div>
    {right}
  </div>
);

// ───────────────────────────────────────────────────────────
// Bottom tab bar
// ───────────────────────────────────────────────────────────
const TabBar = ({ tabs, value, onChange }) => (
  <div style={{
    display: 'flex', borderTop: `1px solid ${T.colors.border}`,
    background: T.colors.white, fontFamily: T.font,
  }}>
    {tabs.map(t => {
      const active = t.id === value;
      return (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          flex: 1, background: 'transparent', border: 0, padding: '10px 4px 12px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          cursor: 'pointer',
          color: active ? T.colors.black : T.colors.textSecondary,
        }}>
          <div style={{ position: 'relative' }}>
            <Icon name={t.icon} size={22} stroke={active ? 2.2 : 1.75}/>
            {t.badge && (
              <div style={{
                position: 'absolute', top: -4, right: -8, minWidth: 16, height: 16,
                background: T.colors.red, color: '#fff', borderRadius: 8,
                fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center',
                justifyContent: 'center', padding: '0 4px', border: '1.5px solid #fff',
              }}>{t.badge}</div>
            )}
          </div>
          <span style={{ fontSize: 11, fontWeight: active ? 700 : 500 }}>{t.label}</span>
        </button>
      );
    })}
  </div>
);

// ───────────────────────────────────────────────────────────
// Status pill — supports filled and subtle variants
// ───────────────────────────────────────────────────────────
const StatusPill = ({ status, variant = 'filled', size = 'md' }) => {
  const meta = T.status[status] || { label: status, tone: 'gray' };
  const toneMap = {
    red:   { bg: T.colors.red,     soft: T.colors.redSoft,     text: T.colors.red,     icon: 'alert' },
    amber: { bg: T.colors.warning, soft: T.colors.warningSoft, text: '#92400E',        icon: 'history' },
    green: { bg: T.colors.success, soft: T.colors.successSoft, text: '#166534',        icon: 'check' },
    gray:  { bg: T.colors.closed,  soft: T.colors.closedSoft,  text: T.colors.closed,  icon: 'x' },
  };
  const tone = toneMap[meta.tone];
  const isSubtle = variant === 'subtle';
  const isSm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: isSubtle ? tone.soft : tone.bg,
      color: isSubtle ? tone.text : '#FFFFFF',
      padding: isSm ? '2px 8px' : '4px 10px',
      fontSize: isSm ? 10 : 11, fontWeight: 600,
      borderRadius: 999, lineHeight: 1.4,
      whiteSpace: 'nowrap',
      fontFamily: T.font,
    }}>
      <span style={{
        width: isSm ? 5 : 6, height: isSm ? 5 : 6, borderRadius: '50%',
        background: isSubtle ? tone.bg : '#FFFFFF',
      }}/>
      {meta.label}
    </span>
  );
};

// ───────────────────────────────────────────────────────────
// Buttons
// ───────────────────────────────────────────────────────────
const Button = ({ children, variant = 'primary', size = 'md', icon, iconRight, full, onClick, disabled, style = {} }) => {
  const base = {
    fontFamily: T.font, fontWeight: 700, fontSize: 15,
    border: 0, borderRadius: 999, cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    transition: 'transform 150ms ease, opacity 150ms ease',
    minHeight: size === 'sm' ? 36 : 48,
    padding: size === 'sm' ? '0 16px' : '0 22px',
    width: full ? '100%' : 'auto',
    opacity: disabled ? 0.5 : 1,
    letterSpacing: '-0.005em',
  };
  const variants = {
    primary:    { background: T.colors.black, color: '#FFFFFF' },
    emphasis:   { background: T.colors.red, color: '#FFFFFF' },
    secondary:  { background: T.colors.white, color: T.colors.black, boxShadow: `inset 0 0 0 1.5px ${T.colors.black}` },
    ghost:      { background: 'transparent', color: T.colors.black },
    destructive:{ background: T.colors.white, color: T.colors.red, boxShadow: `inset 0 0 0 1.5px ${T.colors.red}` },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      onMouseDown={e => { if (!disabled) e.currentTarget.style.transform = 'scale(0.97)'; }}
      onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
      style={{ ...base, ...variants[variant], ...style }}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18}/>}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18}/>}
    </button>
  );
};

// ───────────────────────────────────────────────────────────
// Card
// ───────────────────────────────────────────────────────────
const Card = ({ children, onClick, style = {}, dense = false }) => (
  <div onClick={onClick} style={{
    background: T.colors.white,
    borderRadius: 14,
    padding: dense ? 12 : 16,
    boxShadow: '0 1px 0 rgba(10,10,10,0.04), 0 1px 3px rgba(10,10,10,0.06)',
    cursor: onClick ? 'pointer' : 'default',
    fontFamily: T.font,
    ...style,
  }}>{children}</div>
);

// ───────────────────────────────────────────────────────────
// Avatar (initials)
// ───────────────────────────────────────────────────────────
const Avatar = ({ user, size = 40 }) => (
  <div style={{
    width: size, height: size, borderRadius: '50%',
    background: user.color || T.colors.black, color: '#FFFFFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: T.font, fontWeight: 700, fontSize: size * 0.4, flexShrink: 0,
  }}>{user.initials}</div>
);

// ───────────────────────────────────────────────────────────
// Input
// ───────────────────────────────────────────────────────────
const Input = ({ label, value, onChange, placeholder, type = 'text', icon, error, helper, focused }) => {
  const [isFocused, setIsFocused] = React.useState(false);
  const showAccent = focused ?? isFocused;
  const borderColor = error ? T.colors.red : (showAccent ? T.colors.red : T.colors.border);
  const borderWidth = (showAccent || error) ? 2 : 1;
  return (
    <div style={{ fontFamily: T.font }}>
      {label && <div style={{ fontSize: 12, color: T.colors.textSecondary, fontWeight: 600, marginBottom: 6 }}>{label}</div>}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: `${borderWidth}px solid ${borderColor}`,
        paddingBottom: 8 - (borderWidth - 1),
      }}>
        {icon && <Icon name={icon} size={18} color={T.colors.textSecondary}/>}
        <input type={type} value={value || ''} onChange={e => onChange?.(e.target.value)}
          placeholder={placeholder}
          onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)}
          style={{
            flex: 1, border: 0, outline: 'none', background: 'transparent',
            fontSize: 15, fontFamily: T.font, color: T.colors.black,
            padding: '4px 0',
          }}/>
      </div>
      {(error || helper) && (
        <div style={{ marginTop: 6, fontSize: 12, color: error ? T.colors.red : T.colors.textSecondary }}>
          {error || helper}
        </div>
      )}
    </div>
  );
};

// ───────────────────────────────────────────────────────────
// Bottom-sheet modal
// ───────────────────────────────────────────────────────────
const Sheet = ({ open, onClose, children, title, subtitle }) => {
  if (!open) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30,
      background: 'rgba(10,10,10,0.42)',
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      animation: 'redaFade 200ms ease',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: T.colors.white,
        borderTopLeftRadius: 20, borderTopRightRadius: 20,
        maxHeight: '88%', overflowY: 'auto',
        animation: 'redaSheet 280ms cubic-bezier(.2,.8,.2,1)',
        fontFamily: T.font,
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
          <div style={{ width: 40, height: 4, background: T.colors.border, borderRadius: 2 }}/>
        </div>
        {title && (
          <div style={{ padding: '8px 20px 4px' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: T.colors.textSecondary, marginTop: 2 }}>{subtitle}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────
// FAB
// ───────────────────────────────────────────────────────────
const FAB = ({ icon, label, onClick, color = T.colors.red, style = {} }) => (
  <button onClick={onClick} style={{
    position: 'absolute', right: 16, bottom: 80,
    background: color, color: '#FFFFFF',
    height: 52, padding: label ? '0 20px 0 18px' : 0, width: label ? 'auto' : 52,
    borderRadius: 26, border: 0,
    display: 'flex', alignItems: 'center', gap: 8,
    boxShadow: '0 10px 24px rgba(230,48,39,0.35), 0 2px 6px rgba(0,0,0,0.15)',
    fontFamily: T.font, fontWeight: 700, fontSize: 14,
    cursor: 'pointer', zIndex: 5, ...style,
  }}>
    <Icon name={icon} size={22}/>
    {label}
  </button>
);

// ───────────────────────────────────────────────────────────
// Money formatter
// ───────────────────────────────────────────────────────────
const money = (n) => {
  if (n === null || n === undefined) return '—';
  return '₦' + n.toLocaleString('en-NG');
};

// ───────────────────────────────────────────────────────────
// Banner
// ───────────────────────────────────────────────────────────
const Banner = ({ tone = 'info', icon = 'alert', title, children, action }) => {
  const palette = {
    info:  { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
    warn:  { bg: T.colors.warningSoft, border: '#FCD34D', text: '#92400E' },
    error: { bg: T.colors.redSoft, border: '#FCA5A5', text: T.colors.red },
    ok:    { bg: T.colors.successSoft, border: '#86EFAC', text: '#166534' },
  }[tone];
  return (
    <div style={{
      background: palette.bg, color: palette.text,
      border: `1px solid ${palette.border}`,
      borderRadius: 12, padding: 12,
      display: 'flex', gap: 10, alignItems: 'flex-start',
      fontFamily: T.font, fontSize: 13,
    }}>
      <Icon name={icon} size={18}/>
      <div style={{ flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>}
        <div style={{ lineHeight: 1.45 }}>{children}</div>
      </div>
      {action}
    </div>
  );
};

// Empty state
const Empty = ({ icon = 'package', title, sub }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    padding: 40, color: T.colors.textSecondary, textAlign: 'center', fontFamily: T.font,
  }}>
    <div style={{
      width: 64, height: 64, borderRadius: 32,
      background: T.colors.surface, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon name={icon} size={28} color={T.colors.textSecondary} stroke={1.5}/>
    </div>
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.colors.black }}>{title}</div>
      {sub && <div style={{ fontSize: 13, marginTop: 4, maxWidth: 240 }}>{sub}</div>}
    </div>
  </div>
);

// Toast
const Toast = ({ visible, children, tone = 'ok' }) => (
  <div style={{
    position: 'absolute', top: 70, left: 16, right: 16, zIndex: 50,
    pointerEvents: 'none',
    transform: visible ? 'translateY(0)' : 'translateY(-120%)',
    opacity: visible ? 1 : 0,
    transition: 'all 280ms cubic-bezier(.2,.8,.2,1)',
  }}>
    <div style={{
      background: T.colors.black, color: '#FFFFFF', borderRadius: 12,
      padding: '12px 16px', fontFamily: T.font, fontSize: 14, fontWeight: 600,
      display: 'flex', alignItems: 'center', gap: 10,
      boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
    }}>
      <Icon name={tone === 'ok' ? 'check' : 'alert'} size={18} color={tone === 'ok' ? T.colors.success : T.colors.red}/>
      {children}
    </div>
  </div>
);

// Section header (sticky)
const SectionHeader = ({ children, right, sticky }) => (
  <div style={{
    padding: '14px 16px 8px',
    fontFamily: T.font,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: T.colors.surface,
    position: sticky ? 'sticky' : 'static', top: 0, zIndex: 1,
  }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: T.colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{children}</div>
    {right}
  </div>
);

Object.assign(window, {
  Icon, RedaMark, RedaWordmark, AppBar, TabBar, StatusPill, Button, Card, Avatar,
  Input, Sheet, FAB, money, Banner, Empty, Toast, SectionHeader,
});
