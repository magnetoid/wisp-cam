import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SERVER_URL, clearStoredSession, fetchIceServers } from './api.ts';
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
  /** Our own socket dropped — usually a phone changing network or waking up. */
  | 'reconnecting'
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
  /** Reconnection attempts were exhausted; recoverable via `retry()`. */
  const [connectionLost, setConnectionLost] = useState(false);
  /** The session token expired or was rejected; the user needs a new one. */
  const [sessionExpired, setSessionExpired] = useState(false);

  const socketRef = useRef<AppSocket | null>(null);
  const peerRef = useRef<PeerSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
  /**
   * What the user actually wants: the mode they're chatting in, or null if
   * they're not trying to chat. Distinct from `status`, which is where the
   * connection currently is. On a reconnect this is what tells us whether to
   * rejoin the queue — without it the client silently ends up in no queue at
   * all while still showing "Searching".
   */
  const desiredModeRef = useRef<ChatMode | null>(null);
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
      // Skip the HTTP long-polling handshake entirely. Polling is what
      // proxy gzip middleware buffers and breaks, and we never need the
      // fallback for a browser that already supports WebRTC.
      transports: ['websocket'],
      // Mobile networks drop out for far longer than socket.io's default of 5
      // attempts allows — that gives up after roughly 15 seconds, which a
      // tunnel or a Wi-Fi/LTE handover comfortably exceeds. Retry for a few
      // minutes instead of dead-ending the user.
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = socket;

    /**
     * Fires on the first connection and on every reconnect. A reconnect gets a
     * brand-new socket id, and the server released our old room and queue slot
     * the moment we dropped — so if the user still wants to chat, we have to
     * ask for a new partner explicitly.
     */
    socket.on('connect', () => {
      const wanted = desiredModeRef.current;
      if (!wanted) return;

      teardownPeer();
      setMessages([]);
      setStatus('searching');
      socket.emit('queue:join', { mode: wanted });
    });

    socket.on('disconnect', (reason) => {
      teardownPeer();
      setMessages([]);

      // A deliberate server-side disconnect (ban) is terminal; socket.io will
      // not retry it, and neither should we.
      if (reason === 'io server disconnect') {
        desiredModeRef.current = null;
        setStatus('ended');
        return;
      }

      if (desiredModeRef.current) {
        setStatus('reconnecting');
        pushNotice('Connection lost. Reconnecting…', 'warn');
      }
    });

    socket.io.on('reconnect_failed', () => {
      // Intent is deliberately preserved: retrying, or simply returning to the
      // tab, should put the user back in the queue rather than stranding them
      // connected-but-idle.
      setStatus('ended');
      setConnectionLost(true);
    });

    socket.on('connect_error', (err) => {
      if (err.message === 'banned') {
        setBanned({ until: null, reason: 'banned' });
        return;
      }
      // An expired or rejected token cannot be retried into working; send the
      // user back through the entry gate for a fresh one.
      if (err.message === 'unauthorized') {
        desiredModeRef.current = null;
        clearStoredSession();
        setSessionExpired(true);
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
      desiredModeRef.current = null;
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

  /**
   * Phones commonly kill the socket while the tab is backgrounded, and the
   * browser can sit on a dead connection for a while before noticing. Nudging
   * it the moment the user comes back makes the recovery feel immediate
   * instead of taking a reconnect backoff cycle.
   */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      const socket = socketRef.current;
      if (socket && !socket.connected && desiredModeRef.current) socket.connect();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onVisibilityChange);
    };
  }, []);

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

      desiredModeRef.current = nextMode;
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
    desiredModeRef.current = null;
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
    desiredModeRef.current = null;
    socketRef.current?.emit('peer:nsfw-selfreport');
    teardownPeer();
    setStatus('ended');
  }, [teardownPeer]);

  /**
   * Manual retry after reconnection attempts ran out. Cheaper than a reload:
   * the session token and camera stream are still valid, so this recovers in
   * place rather than sending the user back through the entry gate.
   */
  const retry = useCallback(() => {
    setConnectionLost(false);
    const socket = socketRef.current;
    if (!socket) return;
    if (socket.connected) socket.disconnect();
    socket.connect();
  }, []);

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
      connectionLost,
      sessionExpired,
      start,
      next,
      stop,
      sendMessage,
      report,
      selfReportNsfw,
      retry,
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
      connectionLost,
      sessionExpired,
      start,
      next,
      stop,
      sendMessage,
      report,
      selfReportNsfw,
      retry,
      toggleCamera,
      toggleMic,
    ],
  );
}

export type ChatController = ReturnType<typeof useChat>;
