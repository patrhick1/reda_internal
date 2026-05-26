// Web stub for ./agora.ts. Voice calls are mobile-only — the web bundle
// imports this file instead of the native module so Metro doesn't try to
// resolve react-native-agora (which pulls in `codegenNativeComponent`, a
// native-only RN internal).
//
// Every exported function throws or no-ops because every call site is
// already gated by canPlaceCall() (see ../calls/availability.ts). These
// throws are defensive — they should never run.

import type { IRtcEngine, IRtcEngineEventHandler } from 'react-native-agora';

const NOT_SUPPORTED =
  'Voice calls are not available on web. Open the Reda Android app on your phone to place a call.';

export function getEngine(_appId: string): IRtcEngine {
  throw new Error(NOT_SUPPORTED);
}

export function joinChannel(
  _appId: string,
  _token: string,
  _channel: string,
  _uid: number,
): void {
  throw new Error(NOT_SUPPORTED);
}

export function leaveChannel(): void {
  // noop — no engine exists on web
}

export function setMuted(_muted: boolean): void {
  // noop
}

export function setSpeakerOn(_on: boolean): void {
  // noop
}

export function renewToken(_token: string): void {
  // noop
}

export function registerEventHandler(_handler: IRtcEngineEventHandler): void {
  // noop
}

export function unregisterEventHandler(_handler: IRtcEngineEventHandler): void {
  // noop
}

export function destroyEngine(): void {
  // noop
}
