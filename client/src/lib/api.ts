import type { SessionResponse, TurnResponse } from '@shared/protocol.ts';

export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

const TOKEN_KEY = 'c2c.session';

interface StoredSession {
  token: string;
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function loadStoredSession(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.expiresAt < Date.now() + 60_000) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

function storeSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session));
  } catch {
    // Private browsing with storage disabled: the token still works in memory.
  }
}

export function clearStoredSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function createSession(input: {
  birthDate: string;
  turnstileToken?: string;
}): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof body.error === 'string' ? body.error : 'unknown';
    throw new ApiError(messageForCode(code, body), code, body);
  }

  const data = (await res.json()) as SessionResponse;
  storeSession({ token: data.token, expiresAt: data.expiresAt });
  return data.token;
}

function messageForCode(code: string, body: Record<string, unknown>): string {
  switch (code) {
    case 'banned': {
      const until = typeof body.until === 'number' ? new Date(body.until) : null;
      return until
        ? `Access suspended until ${until.toLocaleString()}.`
        : 'Access to this service has been permanently suspended.';
    }
    case 'age-requirement':
      return 'You must be 18 or older to use this service.';
    case 'bot-check-failed':
      return "We couldn't verify you're human. Please reload and try again.";
    case 'rate-limited':
      return 'Too many attempts from your network. Try again later.';
    default:
      return 'Could not start a session. Please try again.';
  }
}

export async function fetchIceServers(token: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${SERVER_URL}/api/ice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ICE request failed: ${res.status}`);
    const data = (await res.json()) as TurnResponse;
    return data.iceServers as RTCIceServer[];
  } catch (err) {
    console.error('[ice] falling back to public STUN:', err);
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
}

export interface PublicConfig {
  turnstileSiteKey: string | null;
  abuseContactEmail: string;
  logRetentionDays: number;
}

export async function fetchPublicConfig(): Promise<PublicConfig> {
  try {
    const res = await fetch(`${SERVER_URL}/api/config`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as PublicConfig;
  } catch {
    return { turnstileSiteKey: null, abuseContactEmail: 'abuse@example.com', logRetentionDays: 30 };
  }
}
