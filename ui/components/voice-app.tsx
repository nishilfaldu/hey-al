"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RoomAudioRenderer, RoomContext, useAudioPlayback, useConnectionState,
  useLocalParticipant, useTrackVolume, useTranscriptions, useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, createLocalAudioTrack, Room, RoomEvent, type LocalAudioTrack } from "livekit-client";
import { Orb } from "./orb";

type Transcript = { id: string; speaker: string; text: string };
type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";
const labels: Record<VoiceState, string> = {
  idle: "Ready", connecting: "Connecting", listening: "Listening",
  thinking: "Thinking", speaking: "Speaking", muted: "Muted", error: "Disconnected",
};

function Icon({ name }: { name: "mic" | "muted" | "end" | "transcript" | "close" | "sound" }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "mic" || name === "muted" ? <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{name === "muted" && <path d="m3 3 18 18" />}</> : null}
    {name === "end" && <><path d="M3 14c0-6 18-6 18 0v3l-5-1v-3M3 14v3l5-1v-3" /></>}
    {name === "transcript" && <><path d="M5 5h14v12H9l-4 4V5Z" /><path d="M9 9h6M9 13h4" /></>}
    {name === "close" && <path d="m6 6 12 12M18 6 6 18" />}
    {name === "sound" && <><path d="M11 4 6 8H3v8h3l5 4V4Z" /><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>}
  </svg>;
}

function microphoneError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") return "Microphone access is off. Allow it in your browser's site settings, then try again.";
    if (error.name === "NotFoundError") return "No microphone found. Connect one and try again.";
    if (error.name === "NotReadableError") return "Your microphone is busy. Close other apps using it and try again.";
  }
  return null;
}

export function VoiceApp({ onSessionExpired }: { onSessionExpired?: () => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const pendingTrack = useRef<LocalAudioTrack | null>(null);
  const attempt = useRef(0);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const endCall = useCallback(() => {
    attempt.current += 1;
    busy.current = false;
    request.current?.abort();
    pendingTrack.current?.stop();
    pendingTrack.current = null;
    const current = roomRef.current;
    roomRef.current = null;
    void current?.disconnect();
    setRoom(null);
    setStarting(false);
  }, []);

  const failCall = useCallback((message: string) => {
    endCall();
    setError(message);
  }, [endCall]);

  useEffect(() => () => {
    attempt.current += 1;
    request.current?.abort();
    pendingTrack.current?.stop();
    const current = roomRef.current;
    roomRef.current = null;
    void current?.disconnect();
  }, []);

  const startCall = async () => {
    if (busy.current || roomRef.current) return;
    busy.current = true;
    const currentAttempt = ++attempt.current;
    setStarting(true);
    setError(null);
    setTranscript([]);
    let track: LocalAudioTrack | undefined;
    let nextRoom: Room | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Use localhost or an HTTPS address to enable your microphone.");
      // Ask before creating a voice session; a denied microphone never joins a room.
      track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      if (attempt.current !== currentAttempt) { track.stop(); return; }
      pendingTrack.current = track;
      const controller = new AbortController();
      request.current = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch("/api/voice", { method: "POST", signal: controller.signal });
      } finally { clearTimeout(timeout); }
      const details = await response.json();
      if (response.status === 401) { track.stop(); endCall(); onSessionExpired?.(); return; }
      if (!response.ok) throw new Error(details.error || "Couldn't start the call. Try again.");
      if (attempt.current !== currentAttempt) { track.stop(); return; }
      nextRoom = new Room({ adaptiveStream: true, dynacast: true });
      const connectedRoom = nextRoom;
      roomRef.current = nextRoom;
      nextRoom.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === connectedRoom) failCall("The call disconnected. Start a new conversation when you're ready.");
      });
      setRoom(nextRoom);
      await nextRoom.connect(details.serverUrl, details.participantToken);
      if (attempt.current !== currentAttempt) { track.stop(); await nextRoom.disconnect(); return; }
      await nextRoom.localParticipant.publishTrack(track);
      if (attempt.current !== currentAttempt) { track.stop(); await nextRoom.disconnect(); return; }
      pendingTrack.current = null;
      setStarting(false);
      busy.current = false;
    } catch (cause) {
      track?.stop();
      if (attempt.current !== currentAttempt) return;
      const message = microphoneError(cause) || (cause instanceof Error && cause.name !== "AbortError" ? cause.message : "The connection took too long. Try again.");
      failCall(message);
    }
  };

  const common = { starting, error, transcript, showTranscript, setShowTranscript, startCall, endCall };
  return <main className="voice-app">
    {room ? <RoomContext.Provider value={room}>
      <ConnectedVoice {...common} onError={failCall} onTranscript={setTranscript} />
      <RoomAudioRenderer />
    </RoomContext.Provider> : <VoiceScene {...common} state={starting ? "connecting" : error ? "error" : "idle"} energy={0} />}
    <button className="transcript-toggle icon-button" aria-label="Conversation chat" onClick={() => setShowTranscript(!showTranscript)} aria-expanded={showTranscript} aria-controls="transcript-panel"><Icon name="transcript" /></button>
  </main>;
}

type SharedProps = {
  starting: boolean; error: string | null; transcript: Transcript[]; showTranscript: boolean;
  setShowTranscript: (value: boolean) => void; startCall: () => void; endCall: () => void;
};

function ConnectedVoice(props: SharedProps & { onError: (message: string) => void; onTranscript: (messages: Transcript[]) => void }) {
  const { agent, state, audioTrack } = useVoiceAssistant();
  const connection = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();
  const speakerVolume = useTrackVolume(audioTrack);
  const microphoneVolume = useTrackVolume(microphoneTrack?.track as LocalAudioTrack | undefined);
  const messages = useTranscriptions();
  const { canPlayAudio, startAudio } = useAudioPlayback();
  const [muting, setMuting] = useState(false);
  const { onError, onTranscript } = props;

  useEffect(() => {
    onTranscript(messages.map((message) => ({ id: message.streamInfo.id, speaker: message.participantInfo.identity === localParticipant.identity ? "You" : "Al", text: message.text })));
  }, [messages, localParticipant.identity, onTranscript]);

  useEffect(() => {
    if (agent || connection !== ConnectionState.Connected) return;
    const timer = setTimeout(() => onError("Al didn't join the call. Start the voice worker, then try again."), 30_000);
    return () => clearTimeout(timer);
  }, [agent, connection, onError]);

  const toggleMute = async () => {
    setMuting(true);
    try { await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled); }
    catch (cause) { onError(microphoneError(cause) || "Couldn't change your microphone. Please start a new call."); }
    finally { setMuting(false); }
  };
  const voiceState: VoiceState = connection !== ConnectionState.Connected || props.starting || state === "connecting" || state === "initializing"
    ? "connecting" : state === "speaking" ? "speaking" : state === "thinking" ? "thinking" : !isMicrophoneEnabled ? "muted" : "listening";
  return <VoiceScene {...props} state={voiceState} energy={state === "speaking" ? speakerVolume : isMicrophoneEnabled ? microphoneVolume : 0}
    muted={!isMicrophoneEnabled} toggleMute={toggleMute} muting={muting} enableAudio={!canPlayAudio ? () => { void startAudio().catch(() => onError("Audio playback is blocked. Check your browser's sound settings and try again.")); } : undefined} />;
}

function VoiceScene({ state, energy, starting, error, transcript, showTranscript, setShowTranscript, startCall, endCall, muted, toggleMute, muting, enableAudio }: SharedProps & {
  state: VoiceState; energy: number; muted?: boolean; toggleMute?: () => void; muting?: boolean; enableAudio?: () => void;
}) {
  const inCall = Boolean(toggleMute);
  const transcriptBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = transcriptBox.current;
    if (box && showTranscript) box.scrollTop = box.scrollHeight;
  }, [transcript, showTranscript]);
  return <>
    <section className="conversation" aria-label="Voice conversation">
      <div className="orb-stage">
        <button className="orb-button" onClick={!inCall && !starting ? startCall : undefined} disabled={inCall || starting} aria-label="Start voice conversation">
          <Orb energy={energy} active={inCall || starting} />
        </button>
      </div>
      <div className="status" role="status" aria-live="polite" title={error || undefined}><span className={`status-dot ${inCall ? "status-dot-active" : ""}`} /><span>{labels[state]}</span></div>
      {error && <span className="sr-only" role="alert">{error}</span>}
      <div className="call-controls">
        {inCall ? <>
          <button className={`round-control ${muted ? "is-muted" : ""}`} onClick={toggleMute} disabled={starting || muting} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted}><Icon name={muted ? "muted" : "mic"} /></button>
          <button className="round-control end-control" onClick={endCall} aria-label="End call"><Icon name="end" /></button>
        </> : starting ? <button className="round-control" onClick={endCall} aria-label="Cancel call"><Icon name="close" /></button> : <button className="start-control" onClick={startCall}><Icon name="mic" />Start talking</button>}
        {inCall && enableAudio && <button className="round-control" onClick={enableAudio} aria-label="Enable sound"><Icon name="sound" /></button>}
      </div>
    </section>
    {showTranscript && <aside className="transcript-panel" id="transcript-panel" aria-label="Conversation transcript">
      <div className="transcript-heading"><h2>Conversation</h2><button className="icon-button" aria-label="Close transcript" onClick={() => setShowTranscript(false)}><Icon name="close" /></button></div>
      <div className="transcript-messages" ref={transcriptBox} aria-live="polite" aria-relevant="additions text">
        {transcript.map((message) => <div key={message.id} className={`transcript-message ${message.speaker === "You" ? "from-you" : ""}`}><span>{message.speaker}</span><p>{message.text}</p></div>)}
      </div>
    </aside>}
  </>;
}
