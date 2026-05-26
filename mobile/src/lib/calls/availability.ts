import { Platform } from 'react-native';

// Single source of truth for "can this device place a call?"
//
// Voice calling depends on react-native-agora (audio bridge) and
// react-native-callkeep (incoming-ring UI) — both Android-native modules
// with no web equivalent. Rather than scatter `Platform.OS === 'web'`
// checks across every call entry point, every UI surface that exposes a
// Call button asks this helper.
//
// If we later add Agora Web SDK support, this is the single line to flip.
export function canPlaceCall(): boolean {
  return Platform.OS !== 'web';
}

// Copy shown next to disabled call entry points on web. Single source of
// truth so the wording stays consistent between the team directory and
// the per-delivery Call button.
export const CALL_UNSUPPORTED_HINT =
  'Calls work on the Reda Android app. Open the app on your phone to place a call.';
