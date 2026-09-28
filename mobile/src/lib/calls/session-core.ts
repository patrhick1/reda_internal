import type { AgoraToken, Call } from '../../services/calls';

export const isLiveCall = (call: Call | null): call is Call =>
  call?.status === 'ringing' || call?.status === 'accepted';

export type CallSnapshot = {
  call: Call | null;
  connected: boolean;
  remoteJoined: boolean;
  reconnecting: boolean;
  muted: boolean;
  speaker: boolean;
  ending: boolean;
  error: string | null;
};

type AudioEvents = {
  connected: () => void;
  remote: (joined: boolean) => void;
  reconnecting: (value: boolean) => void;
  renew: () => void;
  error: (message: string) => void;
};

export type SessionDependencies = {
  active: () => Promise<Call | null>;
  get: (id: string) => Promise<Call | null>;
  token: (id: string) => Promise<AgoraToken>;
  finish: (call: Call) => Promise<Call>;
  connect: (token: AgoraToken, events: AudioEvents) => void;
  disconnect: () => void;
  renew: (token: string) => void;
  mute: (value: boolean) => void;
  speaker: (value: boolean) => void;
  dismiss: (id: string) => void;
  message: (error: unknown) => string;
};

const empty = (): CallSnapshot => ({
  call: null,
  connected: false,
  remoteJoined: false,
  reconnecting: false,
  muted: false,
  speaker: false,
  ending: false,
  error: null,
});

/** One session per signed-in app, independent of navigation/screen lifetimes. */
export function createCallSession(deps: SessionDependencies) {
  let snapshot = empty();
  let owner: string | null = null;
  let generation = 0;
  let revision = 0;
  let joined = false;
  let hangupRequested = false;
  let joining: Promise<void> | null = null;
  let starting: Promise<Call> | null = null;
  let refreshing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<CallSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const release = () => {
    generation++;
    joining = null;
    joined = false;
    deps.disconnect();
    if (snapshot.call) deps.dismiss(snapshot.call.id);
  };

  async function join(): Promise<void> {
    if (!isLiveCall(snapshot.call) || joined || snapshot.ending || hangupRequested) return;
    if (joining) return joining;
    const callId = snapshot.call.id;
    const ticket = generation;
    const current = () => ticket === generation && snapshot.call?.id === callId && !snapshot.ending;
    const task = (async () => {
      try {
        const token = await deps.token(callId);
        if (!current()) return;
        // Install handlers before joining so the initial connection is observed.
        deps.connect(token, {
          connected: () => {
            if (current()) publish({ connected: true, reconnecting: false, error: null });
          },
          remote: (remoteJoined) => {
            if (current()) publish({ remoteJoined, reconnecting: !remoteJoined });
          },
          reconnecting: (reconnecting) => {
            if (current()) publish({ reconnecting });
          },
          error: (error) => {
            if (current()) publish({ error });
          },
          renew: () => {
            void deps
              .token(callId)
              .then((next) => {
                if (current()) deps.renew(next.token);
              })
              .catch((error) => {
                if (current()) publish({ error: deps.message(error) });
              });
          },
        });
        deps.mute(snapshot.muted);
        deps.speaker(snapshot.speaker);
        joined = true;
        publish({ error: null });
      } catch (error) {
        if (current()) {
          deps.disconnect();
          publish({ error: deps.message(error), reconnecting: true });
        }
      }
    })();
    joining = task;
    try {
      await task;
    } finally {
      if (joining === task) joining = null;
    }
  }

  function adopt(call: Call | null) {
    if (snapshot.call?.id !== call?.id || !isLiveCall(call)) {
      release();
      hangupRequested = false;
      publish({ ...empty(), call });
    } else {
      publish({ call });
    }
    if (isLiveCall(call)) void join();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setUser(userId: string | null) {
      if (owner === userId) return;
      owner = userId;
      hangupRequested = false;
      revision++;
      release();
      starting = null;
      refreshing = null;
      publish(empty());
    },
    adopt(call: Call) {
      if (!owner || (call.caller_id !== owner && call.callee_id !== owner)) return;
      revision++;
      adopt(call);
    },
    async start(begin: () => Promise<Call>): Promise<Call> {
      if (!owner) throw new Error('Sign in before starting a call.');
      if (starting) return starting;
      const ticket = ++revision;
      const task = (async () => {
        // The server returns an existing session on this device or starts one.
        const call = await begin();
        if (ticket !== revision) throw new Error('The call session changed. Please try again.');
        adopt(call);
        return call;
      })();
      starting = task;
      try {
        return await task;
      } finally {
        if (starting === task) starting = null;
      }
    },
    async refresh(): Promise<void> {
      if (!owner || snapshot.ending) return;
      if (refreshing) return refreshing;
      const ticket = revision;
      const task = (async () => {
        try {
          const active = await deps.active();
          if (ticket !== revision || snapshot.ending) return;
          if (active) adopt(active);
          else if (isLiveCall(snapshot.call)) {
            const previous = await deps.get(snapshot.call.id);
            if (ticket !== revision || snapshot.ending) return;
            if (!isLiveCall(previous)) adopt(previous);
          }
        } catch (error) {
          if (ticket === revision && isLiveCall(snapshot.call))
            publish({ error: deps.message(error), reconnecting: true });
        }
      })();
      refreshing = task;
      try {
        await task;
      } finally {
        if (refreshing === task) refreshing = null;
      }
    },
    async end(): Promise<void> {
      const call = snapshot.call;
      if (!isLiveCall(call) || snapshot.ending) return;
      const ticket = ++revision;
      // Invalidate token work before the end request; never join after hang-up.
      hangupRequested = true;
      generation++;
      joining = null;
      publish({ ending: true, error: null });
      try {
        const ended = await deps.finish(call);
        if (ticket === revision) adopt(ended);
      } catch (error) {
        if (ticket === revision) {
          // Keep the controls visible so a failed end request can be retried.
          release();
          publish({
            ending: false,
            connected: false,
            remoteJoined: false,
            error: deps.message(error),
          });
        }
      }
    },
    reconnect() {
      if (!isLiveCall(snapshot.call) || snapshot.ending) return;
      hangupRequested = false;
      generation++;
      joining = null;
      joined = false;
      deps.disconnect();
      publish({ connected: false, remoteJoined: false, error: null, reconnecting: true });
      void join();
    },
    mute() {
      const muted = !snapshot.muted;
      deps.mute(muted);
      publish({ muted });
    },
    speaker() {
      const speaker = !snapshot.speaker;
      deps.speaker(speaker);
      publish({ speaker });
    },
  };
}
