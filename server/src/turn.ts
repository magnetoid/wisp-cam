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
 * Mints short-lived TURN credentials from Cloudflare Realtime.
 *
 * Roughly 15-20% of consumer connections cannot traverse NAT directly and need
 * a relay, so TURN is not optional for a public deployment. Credentials are
 * short-lived and minted server-side so they cannot be scraped and reused.
 *
 * Falls back to public STUN when unconfigured: fine for local development,
 * but a meaningful share of real-world connections will fail without TURN.
 */
export async function getIceServers(): Promise<TurnResponse> {
  const { keyId, apiToken, ttlSeconds } = config.turn;

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
