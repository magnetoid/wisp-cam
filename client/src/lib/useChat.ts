import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SERVER_URL, fetchIceServers } from './api.ts';
import { PeerSession, type PeerState } from './peer.ts';
import type {
  ChatBlockReason,
  ChatMode,
  ClientToServerEvents,
  PeerLeftReason,
  ReportReason,
  ServerToClientEvents,
} from '@shared/protocol.ts';

export type ChatStatus =
  | 'idle'
  | 'requesting-media'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface ChatMessage {
  id: number;
  text: string;
  mine: boolean;
  at: number;
}

export interface SystemNotice {
  id: number;
  text: string;
  tone: 'info' | 'warn';
}

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const BLOCK_MESSAGES: Record<ChatBlockReason, string> = {
  profanity: 'Message not sent — keep it civil.',
  'contact-info': 'Message not sent — sharing contact details is not allowed here.',
  link: 'Message not sent — links are not allowed.',
  'too-long': 'Message not sent — too long.',
  'rate-limit': 'Slow down a little.',
  'no-partner': 'Message not sent — you are not connected to anyone.',
};

const LEFT_MESSAGES: Record<PeerLeftReason, string> = {
  skipped: 'They moved on. Finding someone new…',
  disconnected: 'They disconnected. Finding someone new…',
  stopped: 'They left. Finding someone new…',
  reported: 'Chat ended. Finding someone new…',
  nsfw: 'Chat ended. Finding someone new…',
};

export function useChat(token: string | null) {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [mode, setMode] = useState<ChatMode>('video');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [queuePosition, setQueuePosition] = useState(0);
  const [banned, setBanned] = useState<{ until: number | null; reason: string } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const socketRef = useRef<AppSocket | null>(null);
  const peerRef = useRef<PeerSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
  const modeRef = useRef<ChatMode>('video');
  const noticeId = useRef(0);
  const messageId = useRef(0);

  const pushNotice = useCallback((text: string, tone: SystemNotice['tone'] = 'info') => {
    const id = noticeId.current++;
    setNotices((prev) => [...prev.slice(-3), { id, text, tone }]);
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((n) => n.id !== id));
    }, 4000);
  }, []);

  const teardownPeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
  }, []);

  /**
   * Acquires the camera once and keeps it for the whole visit. Releasing it
   * between matches would re-prompt on some browsers and add a visible stall
   * to every skip.
   */
  const ensureLocalMedia = useCallback(async (): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;

    setStatus('requesting-media');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMediaError(null);
      return stream;
    } catch (err) {
      const name = (err as DOMException).name;
      setMediaError(
        name === 'NotAllowedError'
          ? 'Camera and microphone access was denied. Allow access, or use text-only chat.'
          : name === 'NotFoundError'
            ? 'No camera or microphone found. You can still use text-only chat.'
            : 'Could not start your camera. You can still use text-only chat.',
      );
      setStatus('idle');
      return null;
    }
  }, []);

  // --- Socket lifecycle ----------------------------------------------------

  useEffect(() => {
    if (!token) return;

    const socket: AppSocket = io(SERVER_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    socket.on('connect_error', (err) => {
      if (err.message === 'banned') {
        setBanned({ until: null, reason: 'banned' });
      } else {
        pushNotice('Connection problem. Retrying…', 'warn');
      }
    });

    socket.on('queue:waiting', ({ position }) => {
      setQueuePosition(position);
      setStatus('searching');
    });

    socket.on('match:found', async ({ isInitiator, mode: matchedMode }) => {
      teardownPeer();
      setMessages([]);
      setStatus('connecting');

      iceServersRef.current ??= await fetchIceServers(token);

      const peer = new PeerSession({
        iceServers: iceServersRef.current,
        localStream: matchedMode === 'video' ? localStreamRef.current : null,
        isInitiator,
        onDescription: (description) => socket.emit('signal:description', { description }),
        onCandidate: (candidate) => socket.emit('signal:candidate', { candidate }),
        onRemoteStream: (stream) => setRemoteStream(stream),
        onStateChange: (peerState: PeerState) => {
          if (peerState === 'connected') setStatus('connected');
          if (peerState === 'failed') {
            pushNotice("Couldn't connect to them. Finding someone new…", 'warn');
            socket.emit('peer:skip');
          }
        },
      });
      peerRef.current = peer;

      try {
        await peer.start();
      } catch (err) {
        console.error('[chat] failed to start peer session:', err);
        socket.emit('peer:skip');
      }

      // Text-only never fires a media connection event, so mark it live once
      // signaling has completed.
      if (matchedMode === 'text') setStatus('connected');
    });

    socket.on('signal:description', ({ description }) => {
      void peerRef.current?.handleDescription(description);
    });

    socket.on('signal:candidate', ({ candidate }) => {
      void peerRef.current?.handleCandidate(candidate);
    });

    socket.on('chat:message', ({ text, at }) => {
      setMessages((prev) => [...prev, { id: messageId.current++, text, mine: false, at }]);
    });

    socket.on('chat:blocked', ({ reason, clientId }) => {
      // Retract the optimistic bubble: the message was never delivered, and
      // leaving it on screen would tell the sender it had been.
      setMessages((prev) => prev.filter((message) => message.id !== clientId));
      pushNotice(BLOCK_MESSAGES[reason] ?? 'Message not sent.', 'warn');
    });

    socket.on('peer:left', ({ reason }) => {
      teardownPeer();
      setMessages([]);
      pushNotice(LEFT_MESSAGES[reason] ?? 'Chat ended.');
      setStatus('searching');
    });

    socket.on('session:banned', ({ until, reason }) => {
      setBanned({ until, reason });
      teardownPeer();
      setStatus('ended');
    });

    socket.on('error:notice', ({ message }) => pushNotice(message, 'warn'));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, pushNotice, teardownPeer]);

  // Release the camera when the component tree unmounts.
  useEffect(() => {
    return () => {
      peerRef.current?.close();
      for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
      localStreamRef.current = null;
    };
  }, []);

  // --- Actions -------------------------------------------------------------

  const start = useCallback(
    async (nextMode: ChatMode) => {
      if (!socketRef.current) return;

      if (nextMode === 'video') {
        const stream = await ensureLocalMedia();
        if (!stream) return;
      }

      modeRef.current = nextMode;
      setMode(nextMode);
      setStatus('searching');
      socketRef.current.emit('queue:join', { mode: nextMode });
    },
    [ensureLocalMedia],
  );

  /** Skip to the next person. The server re-queues both sides. */
  const next = useCallback(() => {
    if (!socketRef.current) return;
    teardownPeer();
    setMessages([]);
    setStatus('searching');
    socketRef.current.emit('peer:skip');
  }, [teardownPeer]);

  const stop = useCallback(() => {
    socketRef.current?.emit('queue:leave');
    teardownPeer();
    setMessages([]);
    setStatus('idle');
  }, [teardownPeer]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !socketRef.current) return;

    // Shown immediately so typing feels responsive, then retracted if the
    // server refuses it. The id correlates the two.
    const id = messageId.current++;
    socketRef.current.emit('chat:send', { text: trimmed, clientId: id });
    setMessages((prev) => [...prev, { id, text: trimmed, mine: true, at: Date.now() }]);
  }, []);

  const report = useCallback(
    (reason: ReportReason, note?: string, snapshot?: string) => {
      socketRef.current?.emit('peer:report', { reason, note, snapshot });
      teardownPeer();
      setMessages([]);
      setStatus('searching');
      pushNotice('Report submitted. Thank you.');
    },
    [pushNotice, teardownPeer],
  );

  /** Called by the local NSFW monitor when it trips on our own camera. */
  const selfReportNsfw = useCallback(() => {
    socketRef.current?.emit('peer:nsfw-selfreport');
    teardownPeer();
    setStatus('ended');
  }, [teardownPeer]);

  const toggleCamera = useCallback((enabled: boolean) => {
    for (const track of localStreamRef.current?.getVideoTracks() ?? []) track.enabled = enabled;
  }, []);

  const toggleMic = useCallback((enabled: boolean) => {
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) track.enabled = enabled;
  }, []);

  return useMemo(
    () => ({
      status,
      mode,
      messages,
      notices,
      localStream,
      remoteStream,
      queuePosition,
      banned,
      mediaError,
      start,
      next,
      stop,
      sendMessage,
      report,
      selfReportNsfw,
      toggleCamera,
      toggleMic,
    }),
    [
      status,
      mode,
      messages,
      notices,
      localStream,
      remoteStream,
      queuePosition,
      banned,
      mediaError,
      start,
      next,
      stop,
      sendMessage,
      report,
      selfReportNsfw,
      toggleCamera,
      toggleMic,
    ],
  );
}

export type ChatController = ReturnType<typeof useChat>;
