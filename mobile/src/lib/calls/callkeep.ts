import { Platform } from 'react-native';

// Thin wrapper around react-native-callkeep. The coordinator (./coordinator.ts)
// owns lifecycle; this file owns the SDK glue.
//
// Defensive require: react-native-callkeep is flagged "untested on New
// Architecture" by react-native-directory. If the native module fails to load
// on a given device, the *static* import would crash this file at module-load
// time — and because this file is transitively imported by app/_layout.tsx,
// that would crash the entire app on startup. Using require + try lets the
// rest of the app boot; calling falls back to "ring via notification" if
// CallKeep isn't available.
let RNCallKeep: any;
let callKeepLoaded = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RNCallKeep = require('react-native-callkeep').default ?? require('react-native-callkeep');
  callKeepLoaded = typeof RNCallKeep?.setup === 'function';
} catch (err) {
  console.warn('[callkeep] native module unavailable; calls will degrade to notification-only', err);
  callKeepLoaded = false;
}

export function isCallKeepAvailable(): boolean {
  return callKeepLoaded;
}

const SETUP_OPTIONS = {
  ios: {
    appName: 'Reda',
    supportsVideo: false,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
  android: {
    alertTitle: 'Reda needs phone permissions',
    alertDescription:
      'Allow Reda to display incoming calls with the system ringtone and lock-screen UI.',
    cancelButton: 'Not now',
    okButton: 'Allow',
    additionalPermissions: [],
    foregroundService: {
      channelId: 'reda.call',
      channelName: 'Reda calls',
      notificationTitle: 'Reda call in progress',
    },
    selfManaged: false,
  },
} as const;

let setupDone = false;

export async function setupCallKeep(): Promise<void> {
  if (setupDone || !callKeepLoaded) return;
  try {
    await RNCallKeep.setup(SETUP_OPTIONS);
    if (Platform.OS === 'android') {
      RNCallKeep.setAvailable(true);
    }
    setupDone = true;
  } catch (err) {
    console.error('[callkeep] setup failed', err);
  }
}

export function displayIncomingCall(callId: string, callerName: string): void {
  if (!callKeepLoaded) return;
  try {
    RNCallKeep.displayIncomingCall(callId, callerName, callerName, 'generic', false);
  } catch (err) {
    console.error('[callkeep] displayIncomingCall failed', err);
  }
}

export function dismissCall(callId: string): void {
  if (!callKeepLoaded) return;
  try { RNCallKeep.endCall(callId); } catch { /* noop */ }
}

export function reportConnected(callId: string): void {
  if (!callKeepLoaded) return;
  try { RNCallKeep.reportConnectedOutgoingCallWithUUID?.(callId); } catch { /* noop */ }
  try { RNCallKeep.setCurrentCallActive(callId); } catch { /* noop */ }
}

type AnswerListener = (data: { callUUID: string }) => void;
type EndListener    = (data: { callUUID: string }) => void;

export function addAnswerListener(cb: AnswerListener): () => void {
  if (!callKeepLoaded) return () => { /* noop */ };
  try {
    RNCallKeep.addEventListener('answerCall', cb);
    return () => { try { RNCallKeep.removeEventListener('answerCall'); } catch { /* noop */ } };
  } catch (err) {
    console.warn('[callkeep] addAnswerListener failed', err);
    return () => { /* noop */ };
  }
}

export function addEndListener(cb: EndListener): () => void {
  if (!callKeepLoaded) return () => { /* noop */ };
  try {
    RNCallKeep.addEventListener('endCall', cb);
    return () => { try { RNCallKeep.removeEventListener('endCall'); } catch { /* noop */ } };
  } catch (err) {
    console.warn('[callkeep] addEndListener failed', err);
    return () => { /* noop */ };
  }
}
