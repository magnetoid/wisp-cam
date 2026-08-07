import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server, type Socket } from 'socket.io';

import { config } from './config.ts';
import { Matchmaker, type Pairing } from './matchmaker.ts';
import { issueSessionToken, meetsAgeRequirement, verifySessionToken, verifyTurnstile } from './auth.ts';
import { getIceServers } from './turn.ts';
import { checkBan, maskIp, recordOffence } from './safety/bans.ts';
import { RateLimiter } from './safety/rateLimit.ts';
import { filterMessage } from './safety/textFilter.ts';
import { appendJsonl, files, pruneJsonl } from './store.ts';
import {
  CHAT_MODES,
  REPORT_REASONS,
  type ChatMode,
  type ClientToServerEvents,
  type PeerLeftReason,
  type ReportReason,
  type ServerToClientEvents,
} from '../../shared/protocol.ts';

interface SocketData {
  sessionId: string;
  ip: string;
  mode: ChatMode | null;
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' })); // report snapshots are data URLs
app.use(cors({ origin: config.allowedOrigins, credentials: false }));

const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  server,
  {
    cors: { origin: config.allowedOrigins },
    // Random chat has short-lived connections; fail fast on dead sockets so
    // nobody sits matched with a ghost.
    pingInterval: 10_000,
    pingTimeout: 8_000,
  },
);

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const sessionLimiter = new RateLimiter(config.limits.sessionsPerIpPerHour, 60 * 60 * 1000);
const joinLimiter = new RateLimiter(config.limits.joinsPerMinute, 60 * 1000);
const chatLimiter = new RateLimiter(config.limits.chatPerTenSeconds, 10_000);
const reportLimiter = new RateLimiter(10, 60 * 60 * 1000);

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, queues: matchmaker.stats(), rooms: rooms.size / 2 });
});

/**
 * Session issuance: the entry gate. Enforces the age declaration, the bot
 * check, IP bans and a per-IP rate limit before handing out a token. No token,
 * no WebSocket connection.
 */
app.post('/api/session', async (req, res) => {
  const ip = clientIp(req);

  const ban = checkBan(ip);
  if (ban.banned) {
    res.status(403).json({
      error: 'banned',
      until: ban.until,
      reason: ban.reason,
      contact: config.abuseContactEmail,
    });
    return;
  }

  if (!sessionLimiter.tryConsume(ip)) {
    res.status(429).json({ error: 'rate-limited' });
    return;
  }

  if (!meetsAgeRequirement(req.body?.birthDate)) {
    res.status(403).json({ error: 'age-requirement' });
    return;
  }

  const humanVerified = await verifyTurnstile(req.body?.turnstileToken, ip);
  if (!humanVerified) {
    res.status(403).json({ error: 'bot-check-failed' });
    return;
  }

  const { token, sessionId, expiresAt } = issueSessionToken();
  appendJsonl(files.sessions, { sessionId, ip, event: 'issued' });

  res.json({ token, expiresAt });
});

app.get('/api/ice', async (req, res) => {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!auth || !verifySessionToken(auth)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json(await getIceServers());
});

app.get('/api/config', (_req, res) => {
  res.json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? null,
    abuseContactEmail: config.abuseContactEmail,
    logRetentionDays: config.logRetentionDays,
  });
});

// ---------------------------------------------------------------------------
// Room bookkeeping
// ---------------------------------------------------------------------------

interface Room {
  roomId: string;
  partnerSocketId: string;
  mode: ChatMode;
  startedAt: number;
}

/** socketId -> room. Both members of a pair each hold an entry. */
const rooms = new Map<string, Room>();

function isAlive(socketId: string): boolean {
  return io.sockets.sockets.has(socketId);
}

const matchmaker = new Matchmaker(isAlive, announcePairing);

function announcePairing(pairing: Pairing): void {
  const { roomId, mode, initiator, responder } = pairing;
  const a = io.sockets.sockets.get(initiator.socketId) as AppSocket | undefined;
  const b = io.sockets.sockets.get(responder.socketId) as AppSocket | undefined;
  if (!a || !b) return;

  const startedAt = Date.now();
  rooms.set(a.id, { roomId, partnerSocketId: b.id, mode, startedAt });
  rooms.set(b.id, { roomId, partnerSocketId: a.id, mode, startedAt });

  a.emit('match:found', { roomId, isInitiator: true, mode });
  b.emit('match:found', { roomId, isInitiator: false, mode });
}

function partnerOf(socket: AppSocket): AppSocket | null {
  const room = rooms.get(socket.id);
  if (!room) return null;
  return (io.sockets.sockets.get(room.partnerSocketId) as AppSocket | undefined) ?? null;
}

/**
 * Tears down a pairing and tells the partner why.
 *
 * `requeuePartner` puts the partner straight back at the front of the queue:
 * being skipped should not also cost them their place in line.
 */
function endPairing(socket: AppSocket, reason: PeerLeftReason, requeuePartner = true): void {
  const room = rooms.get(socket.id);
  if (!room) return;

  rooms.delete(socket.id);
  rooms.delete(room.partnerSocketId);

  const partner = io.sockets.sockets.get(room.partnerSocketId) as AppSocket | undefined;
  if (!partner) return;

  partner.emit('peer:left', { reason });

  if (requeuePartner && partner.data.mode) {
    matchmaker.enqueue(
      { socketId: partner.id, sessionId: partner.data.sessionId, mode: partner.data.mode },
      { priority: true },
    );
    partner.emit('queue:waiting', matchmaker.position(partner.id));
  }
}

// ---------------------------------------------------------------------------
// Socket auth + signaling
// ---------------------------------------------------------------------------

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  const claims = token ? verifySessionToken(token) : null;
  if (!claims) return next(new Error('unauthorized'));

  const ip =
    (socket.handshake.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    socket.handshake.address;

  const ban = checkBan(ip);
  if (ban.banned) return next(new Error('banned'));

  const data = socket.data as SocketData;
  data.sessionId = claims.sid;
  data.ip = ip;
  data.mode = null;
  next();
});

io.on('connection', (rawSocket) => {
  const socket = rawSocket as AppSocket;

  socket.on('queue:join', ({ mode }) => {
    if (!CHAT_MODES.includes(mode)) return;

    if (!joinLimiter.tryConsume(socket.data.sessionId)) {
      socket.emit('error:notice', { message: 'Slow down a moment before finding someone new.' });
      return;
    }

    // Joining a queue while paired implicitly abandons the current partner.
    if (rooms.has(socket.id)) endPairing(socket, 'skipped');

    socket.data.mode = mode;
    matchmaker.enqueue({ socketId: socket.id, sessionId: socket.data.sessionId, mode });
    socket.emit('queue:waiting', matchmaker.position(socket.id));
  });

  socket.on('queue:leave', () => {
    matchmaker.dequeue(socket.id);
    socket.data.mode = null;
    if (rooms.has(socket.id)) endPairing(socket, 'stopped');
  });

  socket.on('peer:skip', () => {
    if (!joinLimiter.tryConsume(socket.data.sessionId)) {
      socket.emit('error:notice', { message: 'Slow down a moment before finding someone new.' });
      return;
    }

    endPairing(socket, 'skipped');

    // The skipper goes to the back of their own queue.
    if (socket.data.mode) {
      matchmaker.enqueue({
        socketId: socket.id,
        sessionId: socket.data.sessionId,
        mode: socket.data.mode,
      });
      socket.emit('queue:waiting', matchmaker.position(socket.id));
    }
  });

  // --- WebRTC signaling: opaque relay, never inspected ---------------------

  socket.on('signal:description', ({ description }) => {
    partnerOf(socket)?.emit('signal:description', { description });
  });

  socket.on('signal:candidate', ({ candidate }) => {
    partnerOf(socket)?.emit('signal:candidate', { candidate });
  });

  // --- Text chat: relayed through the server so it can be filtered ---------

  socket.on('chat:send', ({ text, clientId }) => {
    const partner = partnerOf(socket);
    const id = typeof clientId === 'number' ? clientId : -1;

    if (!partner) {
      socket.emit('chat:blocked', { reason: 'no-partner', clientId: id });
      return;
    }

    if (!chatLimiter.tryConsume(socket.data.sessionId)) {
      socket.emit('chat:blocked', { reason: 'rate-limit', clientId: id });
      return;
    }

    const result = filterMessage(text);
    if (!result.ok) {
      socket.emit('chat:blocked', { reason: result.reason, clientId: id });
      return;
    }

    // Relayed, never persisted.
    partner.emit('chat:message', { text: result.text, at: Date.now() });
  });

  // --- Abuse reporting ----------------------------------------------------

  socket.on('peer:report', ({ reason, note, snapshot }) => {
    const room = rooms.get(socket.id);
    const partner = partnerOf(socket);

    if (!reportLimiter.tryConsume(socket.data.sessionId)) {
      socket.emit('error:notice', { message: 'Too many reports from this session.' });
      return;
    }

    const safeReason: ReportReason = REPORT_REASONS.includes(reason) ? reason : 'other';

    appendJsonl(files.reports, {
      roomId: room?.roomId ?? null,
      reporterSession: socket.data.sessionId,
      reporterIp: socket.data.ip,
      reportedSession: partner?.data.sessionId ?? null,
      reportedIp: partner?.data.ip ?? null,
      reason: safeReason,
      note: typeof note === 'string' ? note.slice(0, 500) : undefined,
      // Evidence frame, only captured at the moment of a report.
      snapshot: typeof snapshot === 'string' ? snapshot.slice(0, 1_500_000) : undefined,
    });

    console.warn(
      `[report] reason=${safeReason} reporter=${socket.data.sessionId.slice(0, 8)} ` +
        `reported=${partner?.data.sessionId.slice(0, 8) ?? 'unknown'} ip=${
          partner ? maskIp(partner.data.ip) : 'unknown'
        }`,
    );

    if (partner) {
      // Reports for the most severe categories act immediately; the rest are
      // recorded for review. A human still reviews every report.
      if (safeReason === 'nudity' || safeReason === 'minor' || safeReason === 'illegal') {
        const status = recordOffence(partner.data.ip, `report:${safeReason}`);
        partner.emit('session:banned', { until: status.until, reason: 'reported' });
        endPairing(socket, 'reported', false);
        matchmaker.dequeue(partner.id);
        partner.disconnect(true);
      } else {
        endPairing(socket, 'reported');
      }
    }

    // The reporter goes back to looking for someone new.
    if (socket.data.mode && !rooms.has(socket.id)) {
      matchmaker.enqueue({
        socketId: socket.id,
        sessionId: socket.data.sessionId,
        mode: socket.data.mode,
      });
      socket.emit('queue:waiting', matchmaker.position(socket.id));
    }
  });

  /**
   * The client's own NSFW detector fired on its own camera. Client-side checks
   * are bypassable, so this is a courtesy signal from honest clients rather
   * than an authoritative one — we still record an offence.
   */
  socket.on('peer:nsfw-selfreport', () => {
    const status = recordOffence(socket.data.ip, 'nsfw-self-detected');
    appendJsonl(files.reports, {
      reportedSession: socket.data.sessionId,
      reportedIp: socket.data.ip,
      reason: 'nudity',
      source: 'client-nsfw-detector',
    });
    endPairing(socket, 'nsfw');
    matchmaker.dequeue(socket.id);
    socket.emit('session:banned', { until: status.until, reason: 'nsfw-detected' });
    socket.disconnect(true);
  });

  socket.on('disconnect', () => {
    matchmaker.dequeue(socket.id);
    endPairing(socket, 'disconnected');
    joinLimiter.forget(socket.data.sessionId);
    chatLimiter.forget(socket.data.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

matchmaker.start();

const sweepTimer = setInterval(() => {
  matchmaker.sweep();
  sessionLimiter.sweep();
  joinLimiter.sweep();
  chatLimiter.sweep();
  reportLimiter.sweep();
}, 60_000);
sweepTimer.unref();

/** Enforce the stated retention window on abuse-handling metadata. */
function pruneLogs(): void {
  pruneJsonl(files.pairings, config.logRetentionDays);
  pruneJsonl(files.sessions, config.logRetentionDays);
}
pruneLogs();
const pruneTimer = setInterval(pruneLogs, 24 * 60 * 60 * 1000);
pruneTimer.unref();

server.listen(config.port, () => {
  console.log(`[c2c] signaling server on :${config.port} (${config.nodeEnv})`);
  console.log(`[c2c] allowed origins: ${config.allowedOrigins.join(', ')}`);
  if (!config.turn.keyId) {
    console.warn('[c2c] no TURN configured — expect ~15-20% of real-world connections to fail');
  }
  if (!config.turnstileSecret) {
    console.warn('[c2c] no Turnstile configured — bot gate is disabled');
  }
});

function shutdown(): void {
  console.log('[c2c] shutting down');
  matchmaker.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
