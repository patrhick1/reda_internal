import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

// Minimal Lucide-style icon set. Path data lifted from the Reda design kit
// so the strokes match the prototype exactly. Add new icons here, not inline.

export type IconName =
  | 'home'
  | 'package'
  | 'truck'
  | 'wallet'
  | 'user'
  | 'users'
  | 'phone'
  | 'mapPin'
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronDown'
  | 'plus'
  | 'check'
  | 'x'
  | 'alert'
  | 'bell'
  | 'search'
  | 'filter'
  | 'refresh'
  | 'settings'
  | 'file'
  | 'calendar'
  | 'warehouse'
  | 'arrowRight'
  | 'arrowDown'
  | 'arrowUp'
  | 'cash'
  | 'bank'
  | 'history'
  | 'bot'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  | 'box'
  | 'moreVertical'
  | 'edit'
  | 'sliders'
  | 'logout'
  | 'share'
  | 'helpCircle'
  | 'mic'
  | 'micOff'
  | 'volume2'
  | 'phoneOff'
  | 'mail';

const PATHS: Record<IconName, React.ReactNode> = {
  home: (
    <>
      <Path d="M3 12 12 3l9 9" />
      <Path d="M5 10v10h14V10" />
    </>
  ),
  package: (
    <>
      <Path d="m12 3 9 5v8l-9 5-9-5V8z" />
      <Path d="M3 8l9 5 9-5" />
      <Path d="M12 13v9" />
    </>
  ),
  truck: (
    <>
      <Path d="M3 6h13v10H3z" />
      <Path d="M16 9h4l1 3v4h-5" />
      <Circle cx="7" cy="18" r="2" />
      <Circle cx="17" cy="18" r="2" />
    </>
  ),
  wallet: (
    <>
      <Path d="M3 7h16a2 2 0 0 1 2 2v9H3z" />
      <Path d="M3 7V5h14v2" />
      <Circle cx="17" cy="13" r="1" />
    </>
  ),
  user: (
    <>
      <Circle cx="12" cy="8" r="4" />
      <Path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  users: (
    <>
      <Circle cx="9" cy="8" r="3.5" />
      <Path d="M3 21c0-4 3-6 6-6s6 2 6 6" />
      <Path d="M16 5a3 3 0 0 1 0 6" />
      <Path d="M21 21c0-3-2-5-5-5" />
    </>
  ),
  phone: (
    <>
      <Path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </>
  ),
  mapPin: (
    <>
      <Path d="M12 22s8-7 8-13a8 8 0 1 0-16 0c0 6 8 13 8 13z" />
      <Circle cx="12" cy="9" r="3" />
    </>
  ),
  chevronRight: (
    <>
      <Path d="m9 6 6 6-6 6" />
    </>
  ),
  chevronLeft: (
    <>
      <Path d="m15 6-6 6 6 6" />
    </>
  ),
  chevronDown: (
    <>
      <Path d="m6 9 6 6 6-6" />
    </>
  ),
  plus: (
    <>
      <Path d="M12 5v14M5 12h14" />
    </>
  ),
  check: (
    <>
      <Path d="m5 12 5 5 9-11" />
    </>
  ),
  x: (
    <>
      <Path d="m6 6 12 12M6 18 18 6" />
    </>
  ),
  alert: (
    <>
      <Path d="M12 8v5" />
      <Circle cx="12" cy="16.5" r={0.5} />
      <Path d="m12 2 10 18H2z" />
    </>
  ),
  bell: (
    <>
      <Path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
      <Path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  search: (
    <>
      <Circle cx="11" cy="11" r="7" />
      <Path d="m21 21-4.5-4.5" />
    </>
  ),
  filter: (
    <>
      <Path d="M3 5h18l-7 8v6l-4-2v-4z" />
    </>
  ),
  refresh: (
    <>
      <Path d="M4 12a8 8 0 0 1 14-5l3-3v6h-6" />
      <Path d="M20 12a8 8 0 0 1-14 5l-3 3v-6h6" />
    </>
  ),
  settings: (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h.1a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  file: (
    <>
      <Path d="M14 3H6v18h12V7z" />
      <Path d="M14 3v4h4" />
    </>
  ),
  calendar: (
    <>
      <Rect x="3" y="5" width="18" height="16" rx="2" />
      <Path d="M3 9h18M8 3v4M16 3v4" />
    </>
  ),
  warehouse: (
    <>
      <Path d="M3 9 12 4l9 5v11H3z" />
      <Path d="M3 14h18M8 20v-6h8v6" />
    </>
  ),
  arrowRight: (
    <>
      <Path d="M5 12h14M13 5l7 7-7 7" />
    </>
  ),
  arrowDown: (
    <>
      <Path d="M12 5v14M5 13l7 7 7-7" />
    </>
  ),
  arrowUp: (
    <>
      <Path d="M12 19V5M5 11l7-7 7 7" />
    </>
  ),
  cash: (
    <>
      <Rect x="3" y="6" width="18" height="12" rx="2" />
      <Circle cx="12" cy="12" r="2.5" />
    </>
  ),
  bank: (
    <>
      <Path d="M3 21h18M5 21V10M19 21V10M9 21v-7M15 21v-7M12 3 3 9h18z" />
    </>
  ),
  history: (
    <>
      <Path d="M4 12a8 8 0 1 0 3-6" />
      <Path d="M3 3v6h6" />
      <Path d="M12 7v5l3 2" />
    </>
  ),
  bot: (
    <>
      <Rect x="4" y="8" width="16" height="11" rx="2" />
      <Path d="M12 3v5M8 12v2M16 12v2" />
    </>
  ),
  eye: (
    <>
      <Path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <Path d="M3 3l18 18" />
      <Path d="M10.5 6.2A10 10 0 0 1 12 6c6 0 10 6 10 6a17.9 17.9 0 0 1-3.2 4M6.6 6.6A17.9 17.9 0 0 0 2 12s4 6 10 6a10 10 0 0 0 4.4-1" />
      <Path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  lock: (
    <>
      <Rect x="4" y="11" width="16" height="10" rx="2" />
      <Path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </>
  ),
  box: (
    <>
      <Path d="m12 3 9 5v8l-9 5-9-5V8z" />
      <Path d="M3 8l9 5 9-5M12 13v9" />
    </>
  ),
  moreVertical: (
    <>
      <Circle cx="12" cy="5" r="1.5" />
      <Circle cx="12" cy="12" r="1.5" />
      <Circle cx="12" cy="19" r="1.5" />
    </>
  ),
  edit: (
    <>
      <Path d="M4 20h4l11-11-4-4L4 16z" />
    </>
  ),
  sliders: (
    <>
      <Path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M18 18h2" />
      <Circle cx="16" cy="6" r="2" />
      <Circle cx="8" cy="12" r="2" />
      <Circle cx="16" cy="18" r="2" />
    </>
  ),
  logout: (
    <>
      <Path d="M9 4H5v16h4" />
      <Path d="m15 8 4 4-4 4M19 12H9" />
    </>
  ),
  share: (
    <>
      <Path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <Path d="m16 6-4-4-4 4" />
      <Path d="M12 2v13" />
    </>
  ),
  helpCircle: (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2.5-2.5 4" />
      <Circle cx="12" cy="17" r={0.5} />
    </>
  ),
  mic: (
    <>
      <Rect x="9" y="2" width="6" height="12" rx="3" />
      <Path d="M5 11a7 7 0 0 0 14 0M12 19v3M8 22h8" />
    </>
  ),
  micOff: (
    <>
      <Path d="M3 3l18 18" />
      <Path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 11V5a3 3 0 0 0-5.9-.7" />
      <Path d="M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-1.6 4.4" />
      <Path d="M12 19v3M8 22h8" />
    </>
  ),
  volume2: (
    <>
      <Path d="M11 5 6 9H3v6h3l5 4z" />
      <Path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" />
    </>
  ),
  phoneOff: (
    <>
      <Path d="M22 17.5a2 2 0 0 1-2 2 16 16 0 0 1-7-1.7M3.4 11.4A16 16 0 0 1 2 6.5a2 2 0 0 1 2-2h4l2 5-2.5 1.5" />
      <Path d="M3 3l18 18" />
    </>
  ),
  mail: (
    <>
      <Rect x="2" y="4" width="20" height="16" rx="2" />
      <Path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
};

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
};

export function Icon({ name, size = 20, color = 'currentColor', stroke = 2 }: IconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </Svg>
  );
}
