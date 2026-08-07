/**
 * Wire protocol shared by client and server.
 *
 * The signaling server is a dumb relay: it never inspects SDP or ICE payloads,
 * it only forwards them between the two sockets of a paired room.
 */

export type ChatMode = 'video' | 'text';

export const CHAT_MODES: ChatMode[] = ['video', 'text'];

/** Reasons a pairing can end. */
export type PeerLeftReason =
  | 'skipped'      // partner pressed Next
  | 'disconnected' // partner's socket dropped
  | 'stopped'      // partner left the chat entirely
  | 'reported'     // partner was reported and removed
  | 'nsfw';        // partner's client self-terminated on NSFW detection

export type ReportReason =
  | 'nudity'
  | 'minor'
  | 'harassment'
  | 'spam'
  | 'illegal'
  | 'other';

export const REPORT_REASONS: ReportReason[] = [
  'nudity',
  'minor',
  'harassment',
  'spam',
  'illegal',
  'other',
];

/** Why a text message was refused by the server-side filter. */
export type ChatBlockReason =
  | 'profanity'
  | 'contact-info'
  | 'link'
  | 'too-long'
  | 'rate-limit'
  | 'no-partner';

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  'queue:join': (payload: { mode: ChatMode }) => void;
  'queue:leave': () => void;

  'signal:description': (payload: { description: RTCSessionDescriptionInitLike }) => void;
  'signal:candidate': (payload: { candidate: RTCIceCandidateInitLike }) => void;

  /**
   * `clientId` correlates a send with the server's verdict, so a client can
   * tell exactly which of its messages was refused.
   */
  'chat:send': (payload: { text: string; clientId: number }) => void;

  'peer:skip': () => void;
  'peer:report': (payload: { reason: ReportReason; note?: string; snapshot?: string }) => void;
  'peer:nsfw-selfreport': () => void;
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'queue:waiting': (payload: { position: number; waitingInMode: number }) => void;

  'match:found': (payload: {
    roomId: string;
    /** Exactly one side of a pair is the initiator; prevents offer glare. */
    isInitiator: boolean;
    mode: ChatMode;
  }) => void;

  'signal:description': (payload: { description: RTCSessionDescriptionInitLike }) => void;
  'signal:candidate': (payload: { candidate: RTCIceCandidateInitLike }) => void;

  'chat:message': (payload: { text: string; at: number }) => void;
  'chat:blocked': (payload: { reason: ChatBlockReason; clientId: number }) => void;

  'peer:left': (payload: { reason: PeerLeftReason }) => void;

  'session:banned': (payload: { until: number | null; reason: string }) => void;
  'error:notice': (payload: { message: string }) => void;
}

// ---------------------------------------------------------------------------
// Structural stand-ins for the browser WebRTC types.
// The server never reads these fields; it only forwards them.
// ---------------------------------------------------------------------------

export interface RTCSessionDescriptionInitLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ---------------------------------------------------------------------------
// HTTP payloads
// ---------------------------------------------------------------------------

export interface SessionRequest {
  /** Cloudflare Turnstile token. Optional when Turnstile is not configured (dev). */
  turnstileToken?: string;
  /** Self-declared birth date, ISO `YYYY-MM-DD`. Verified server-side too. */
  birthDate: string;
}

export interface SessionResponse {
  token: string;
  expiresAt: number;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnResponse {
  iceServers: IceServerConfig[];
  /** Seconds the client may cache this config. */
  ttl: number;
}

export const MAX_CHAT_LENGTH = 2000;
export const MIN_AGE_YEARS = 18;
