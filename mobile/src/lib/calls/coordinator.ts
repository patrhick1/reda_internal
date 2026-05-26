import { router } from 'expo-router';
import * as agora from './agora';
import * as callkeep from './callkeep';
import { ensureMicPermission } from './permissions';
import {
  acceptCall, declineCall, endCall, fetchAgoraToken, type Call,
} from '@/services/calls';

// Callee-side coordinator. Owns the CallKeep system UI lifecycle for incoming
// calls (display → answer/decline → handoff or dismiss). Once a call is
// answered, the in-call screen takes over and the coordinator's role ends.
//
// Caller-side state is NOT managed here — the caller's in-call screen owns
// its own lifecycle since it never invokes CallKeep (the ring UI is purely
// the callee's experience).
//
// Why a module singleton instead of React context: CallKeep event listeners
// fire from native code via a global JS bridge. They have no React tree to
// hang off of. A module-level coordinator is the simplest fit.

type Phase = 'idle' | 'incoming';

type Snapshot = {
  callId:     string | null;
  callerName: string;
};

let phase: Phase = 'idle';
let activeCallId: string | null = null;
let activeCallerName: string = '';
const listeners = new Set<(s: Snapshot) => void>();

function snapshot(): Snapshot {
  return {
    callId:     phase === 'incoming' ? activeCallId : null,
    callerName: activeCallerName,
  };
}

function notify() {
  const s = snapshot();
  listeners.forEach((l) => { try { l(s); } catch { /* noop */ } });
}

export function subscribe(cb: (s: Snapshot) => void): () => void {
  listeners.add(cb);
  // Fire once with current state so subscribers don't wait for a transition.
  try { cb(snapshot()); } catch { /* noop */ }
  return () => { listeners.delete(cb); };
}

export function getIncomingCallId(): string | null {
  return phase === 'incoming' ? activeCallId : null;
}

export function getSnapshot(): Snapshot {
  return snapshot();
}

/** Realtime saw a new ringing row → show the ring UI. Idempotent. */
export function presentIncoming(call: Call, callerName: string): void {
  if (phase === 'incoming' && activeCallId === call.id) return;
  if (phase === 'incoming') {
    declineCall(call.id, 'busy').catch(() => { /* noop */ });
    return;
  }
  activeCallId = call.id;
  activeCallerName = callerName || 'Reda team';
  phase = 'incoming';
  // CallKeep is best-effort — fires the system UI on devices where
  // ConnectionService is available. Even when it doesn't fire (Gionee /
  // Xiaomi / Oppo / etc. that suppress telecom), the IncomingCallOverlay
  // subscribed via subscribe() above will show the in-app ring.
  callkeep.displayIncomingCall(call.id, activeCallerName);
  notify();
}

/** CallKeep 'answerCall' event → accept_call + Agora join + open in-call screen. */
export async function answer(callId: string): Promise<void> {
  if (activeCallId !== callId || phase !== 'incoming') return;

  // Mic gate first — if denied, decline politely so the caller's UI clears
  // instead of timing out at 45s, and we never call accept_call. The caller
  // sees a clean 'declined' status with reason 'mic_denied'.
  const micOk = await ensureMicPermission();
  if (!micOk) {
    declineCall(callId, 'mic_denied').catch(() => { /* noop */ });
    callkeep.dismissCall(callId);
    reset();
    return;
  }

  let accepted = false;
  try {
    await acceptCall(callId);
    accepted = true;
    const t = await fetchAgoraToken(callId);
    agora.joinChannel(t.app_id, t.token, t.channel, t.uid);
    callkeep.reportConnected(callId);
    // Hand off — the in-call screen owns the call from here. We DO NOT call
    // callkeep.dismissCall here; CallKeep stays in 'active' state so the
    // system call-log entry / lock-screen ongoing-call UI works correctly.
    reset();
    router.push(`/call/${callId}`);
  } catch (err) {
    console.error('[coord] answer failed', err);
    callkeep.dismissCall(callId);
    reset();
    // Roll back: if accept_call already succeeded but token/Agora join failed,
    // the row is in 'accepted' state. Without this end_call the caller sits
    // forever on "Connected" with no audio. Best-effort — if it fails the
    // row is stuck, but at least we tried.
    if (accepted) {
      endCall(callId).catch((e) =>
        console.warn('[coord] rollback end_call failed', e),
      );
    }
    throw err;
  }
}

/** CallKeep 'endCall' event during ringing → decline. */
export async function declineFromSystemUI(callId: string): Promise<void> {
  if (activeCallId !== callId || phase !== 'incoming') return;
  declineCall(callId, 'declined from system UI').catch(() => { /* noop */ });
  callkeep.dismissCall(callId);
  reset();
}

/** In-app overlay's Decline button. Same as system UI decline. */
export async function declineFromOverlay(callId: string): Promise<void> {
  return declineFromSystemUI(callId);
}

/** Caller cancelled / row expired while we were still ringing → quiet dismiss. */
export function externallyDismissed(callId: string): void {
  if (activeCallId !== callId || phase !== 'incoming') return;
  callkeep.dismissCall(callId);
  reset();
}

function reset(): void {
  phase = 'idle';
  activeCallId = null;
  activeCallerName = '';
  notify();
}
