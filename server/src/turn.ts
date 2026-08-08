import crypto from 'node:crypto';
import { config } from './config.ts';
import type { IceServerConfig, TurnResponse } from '../../shared/protocol.ts';

const PUBLIC_STUN: IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

interface CachedCreds {
  value: TurnResponse;
  expiresAt: number;
}

let cache: CachedCreds | null = null;

/**
 * The coturn "TURN REST API" scheme (`use-auth-secret` / `static-auth-secret`).
 *
 * The username is an expiry timestamp and the password is its HMAC-SHA1 under a
 * secret shared with coturn. coturn recomputes the HMAC to validate, so no user
 * database is needed and a leaked credential stops working within the TTL.
 */
function mintCoturnCredentials(
  urls: string[],
  secret: string,
  ttlSeconds: number,
  sessionId: string,
): TurnResponse {
  // Username is "<unix-expiry>:<session>" — the timestamp is when the
  // credential stops working, not when it was issued. Including the session id
  // is optional in the spec, but it makes relay usage traceable back to a
  // report, which matters when handling abuse.
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${sessionId}`;

  // HMAC-SHA1 of the username, base64 of the raw digest — coturn recomputes
  // this to validate, so it needs no user database.
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  return {
    iceServers: [...PUBLIC_STUN, { urls, username, credential }],
    ttl: ttlSeconds,
  };
}

/**
 * Mints short-lived TURN credentials from Cloudflare Realtime.
 *
 * Roughly 15-20% of consumer connections cannot traverse NAT directly and need
 * a relay, so TURN is not optional for a public deployment. Credentials are
 * short-lived and minted server-side so they cannot be scraped and reused.
 *
 * Falls back to public STUN when unconfigured: fine for local development,
 * but a meaningful share of real-world connections will fail without TURN.
 */
export async function getIceServers(sessionId: string): Promise<TurnResponse> {
  const { keyId, apiToken, ttlSeconds, urls, staticAuthSecret } = config.turn;

  // Self-hosted coturn takes precedence: no external dependency, no per-GB cost.
  if (urls.length > 0 && staticAuthSecret) {
    return mintCoturnCredentials(urls, staticAuthSecret, ttlSeconds, sessionId);
  }

  if (!keyId || !apiToken) {
    return { iceServers: PUBLIC_STUN, ttl: 3600 };
  }

  // Reuse credentials until they are close to expiry rather than calling the
  // API on every page load.
  if (cache && cache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cache.value;
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);

    const data = (await res.json()) as { iceServers?: IceServerConfig | IceServerConfig[] };
    const servers = data.iceServers
      ? Array.isArray(data.iceServers)
        ? data.iceServers
        : [data.iceServers]
      : [];

    if (servers.length === 0) throw new Error('Cloudflare TURN returned no ICE servers');

    const value: TurnResponse = {
      // Keep public STUN alongside TURN: cheaper paths are tried first.
      iceServers: [...PUBLIC_STUN, ...servers],
      ttl: ttlSeconds,
    };
    cache = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
    return value;
  } catch (err) {
    console.error('[turn] failed to mint credentials:', (err as Error).message);
    return { iceServers: PUBLIC_STUN, ttl: 300 };
  }
}
