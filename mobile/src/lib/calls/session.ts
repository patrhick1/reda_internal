import { useSyncExternalStore } from 'react';
import {
  getActiveCall,
  getCall,
  fetchAgoraToken,
  cancelCall,
  endCall,
  initiateCall as createCall,
  initiateTeamCall as createTeamCall,
} from '@/services/calls';
import { errorMessage } from '@/lib/errors';
import * as agora from './agora';
import * as callkeep from './callkeep';
import { createCallSession } from './session-core';

export const callSession = createCallSession({
  active: getActiveCall,
  get: getCall,
  token: fetchAgoraToken,
  async finish(call) {
    // Acceptance can race a caller's Cancel press. Re-read and end if needed.
    const current = await getCall(call.id);
    if (current?.status === 'accepted') return endCall(call.id);
    try {
      return await cancelCall(call.id);
    } catch (error) {
      const latest = await getCall(call.id);
      if (latest?.status === 'accepted') return endCall(call.id);
      if (latest && latest.status !== 'ringing') return latest;
      throw error;
    }
  },
  connect(token, events) {
    agora.getEngine(token.app_id);
    agora.registerEventHandler({
      onJoinChannelSuccess: () => events.connected(),
      onUserJoined: () => events.remote(true),
      onUserOffline: () => events.remote(false),
      onConnectionStateChanged: (_connection, state) => {
        events.reconnecting(state !== 3);
        if (state === 3) events.connected();
      },
      onTokenPrivilegeWillExpire: () => events.renew(),
      onError: (_code, message) =>
        events.error(message || 'Audio connection failed. Try returning to the call.'),
    });
    agora.joinChannel(token.app_id, token.token, token.channel, token.uid);
  },
  disconnect: agora.destroyEngine,
  renew: agora.renewToken,
  mute: agora.setMuted,
  speaker: agora.setSpeakerOn,
  dismiss: callkeep.dismissCall,
  message: errorMessage,
});

export function useCallSession() {
  return useSyncExternalStore(
    callSession.subscribe,
    callSession.getSnapshot,
    callSession.getSnapshot,
  );
}

export const initiateCall = (options: Parameters<typeof createCall>[0]) =>
  callSession.start(() => createCall(options));
export const initiateTeamCall = (options: Parameters<typeof createTeamCall>[0]) =>
  callSession.start(() => createTeamCall(options));
