import {
  createAgoraRtcEngine,
  ChannelProfileType,
  AudioProfileType,
  AudioScenarioType,
  type IRtcEngine,
  type IRtcEngineEventHandler,
} from 'react-native-agora';

// Singleton engine. Agora's RN SDK doesn't like multiple engine instances and
// the call lifecycle is shorter than the app lifecycle anyway. We init lazily
// on first use and never tear down except on sign-out (or app kill).
let engine: IRtcEngine | null = null;

export function getEngine(appId: string): IRtcEngine {
  if (engine) return engine;
  engine = createAgoraRtcEngine();
  engine.initialize({
    appId,
    channelProfile: ChannelProfileType.ChannelProfileCommunication,
    audioScenario:  AudioScenarioType.AudioScenarioChatroom,
  });
  engine.setAudioProfile(AudioProfileType.AudioProfileSpeechStandard);
  engine.enableAudio();
  return engine;
}

export function joinChannel(
  appId: string,
  token: string,
  channel: string,
  uid: number,
) {
  const e = getEngine(appId);
  e.joinChannel(token, channel, uid, {
    publishMicrophoneTrack: true,
    autoSubscribeAudio:     true,
  });
}

export function leaveChannel() {
  engine?.leaveChannel();
}

export function setMuted(muted: boolean) {
  engine?.muteLocalAudioStream(muted);
}

export function setSpeakerOn(on: boolean) {
  engine?.setEnableSpeakerphone(on);
}

export function renewToken(token: string) {
  engine?.renewToken(token);
}

export function registerEventHandler(handler: IRtcEngineEventHandler) {
  engine?.registerEventHandler(handler);
}

export function unregisterEventHandler(handler: IRtcEngineEventHandler) {
  engine?.unregisterEventHandler(handler);
}

// Tear down on sign-out so the next user gets a fresh engine + audio session.
export function destroyEngine() {
  if (engine) {
    try { engine.leaveChannel(); } catch { /* noop */ }
    engine.release();
    engine = null;
  }
}
