import crypto from 'node:crypto';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function intEnv(name: string, fallback: number): number {
  const v = env(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const jwtSecret = env('JWT_SECRET');

if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  port: intEnv('PORT', 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',

  /** Comma-separated list of allowed browser origins. */
  allowedOrigins: (env('ALLOWED_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Ephemeral secret in dev: restarting the server invalidates old tokens. */
  jwtSecret: jwtSecret ?? crypto.randomBytes(32).toString('hex'),
  sessionTtlSeconds: intEnv('SESSION_TTL_SECONDS', 6 * 60 * 60),

  /** Cloudflare Turnstile. When unset, the bot check is skipped (dev only). */
  turnstileSecret: env('TURNSTILE_SECRET'),

  /**
   * TURN relay. Three ways to supply it, tried in this order:
   *   1. Self-hosted coturn via a shared secret (TURN_URLS + TURN_STATIC_AUTH_SECRET)
   *   2. Cloudflare Realtime TURN (CLOUDFLARE_TURN_*)
   *   3. Public STUN only — development, or accept that ~15-20% of real
   *      connections will fail to traverse NAT.
   */
  turn: {
    /** e.g. "turn:turn.wisp.best:3478?transport=udp,turns:turn.wisp.best:5349?transport=tcp" */
    urls: (env('TURN_URLS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Must match coturn's `static-auth-secret`. */
    staticAuthSecret: env('TURN_STATIC_AUTH_SECRET'),

    keyId: env('CLOUDFLARE_TURN_KEY_ID'),
    apiToken: env('CLOUDFLARE_TURN_API_TOKEN'),
    ttlSeconds: intEnv('TURN_TTL_SECONDS', 2 * 60 * 60),
  },

  /** Where report records and ban state are persisted. */
  dataDir: env('DATA_DIR') ?? './data',

  /** Abuse-handling metadata retention. No chat content is ever stored. */
  logRetentionDays: intEnv('LOG_RETENTION_DAYS', 30),

  matchmaking: {
    /** How often the pairing loop runs. */
    tickMs: intEnv('MATCH_TICK_MS', 200),
    /** How long a partner stays on the "don't rematch me with them" list. */
    recentPartnerTtlMs: intEnv('RECENT_PARTNER_TTL_MS', 5 * 60 * 1000),
    /** Max partners remembered per session. */
    recentPartnerMax: intEnv('RECENT_PARTNER_MAX', 10),
    /**
     * After waiting this long, a user may be rematched with a recent partner
     * rather than wait forever in a nearly empty queue.
     */
    rematchFallbackMs: intEnv('REMATCH_FALLBACK_MS', 15_000),
  },

  limits: {
    /** Sessions issued per IP per hour. */
    sessionsPerIpPerHour: intEnv('SESSIONS_PER_IP_PER_HOUR', 20),
    /** Queue joins per session per minute (skip-spam brake). */
    joinsPerMinute: intEnv('JOINS_PER_MINUTE', 60),
    /** Chat messages per session per 10s. */
    chatPerTenSeconds: intEnv('CHAT_PER_TEN_SECONDS', 15),
  },

  bans: {
    /** Escalating ladder applied per offence count, in milliseconds. */
    ladderMs: [15 * 60 * 1000, 24 * 60 * 60 * 1000],
    /** Offences beyond the ladder are permanent. */
  },

  abuseContactEmail: env('ABUSE_CONTACT_EMAIL') ?? 'abuse@example.com',
} as const;
