// Responsive breakpoint hook. The mobile app also renders on web via
// Expo Web — at 1920px the mobile-shaped chrome wastes horizontal space.
// This hook lets specific screens (Stock Overview, future others) branch
// on viewport width without touching the layout chrome.
//
// Breakpoint thresholds match common practice: sm <768 (phone), md
// 768-1199 (tablet / narrow web), lg ≥1200 (full web).
import { useWindowDimensions } from 'react-native';

export type Breakpoint = 'sm' | 'md' | 'lg';

export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width >= 1200) return 'lg';
  if (width >= 768) return 'md';
  return 'sm';
}

/** Convenience: true for md or lg, false for sm. Use when you only need
 *  the binary "is this a wide viewport?" decision (most screens). */
export function useIsWide(): boolean {
  return useBreakpoint() !== 'sm';
}
