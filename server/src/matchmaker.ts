import crypto from 'node:crypto';
import { config } from './config.ts';
import { appendJsonl, files } from './store.ts';
import { CHAT_MODES, type ChatMode } from '../../shared/protocol.ts';

export interface Waiter {
  socketId: string;
  sessionId: string;
  mode: ChatMode;
  queuedAt: number;
}

export interface Pairing {
  roomId: string;
  mode: ChatMode;
  /** The socket told to create the offer. Exactly one per pair — avoids glare. */
  initiator: Waiter;
  responder: Waiter;
}

/**
 * In-memory matchmaking. One FIFO queue per mode, drained by a loop that runs
 * every `tickMs`. Matching on a loop rather than on-arrival lets us apply the
 * same liveness and recent-partner rules to everyone in the queue, instead of
 * racing whoever happens to arrive first.
 */
export class Matchmaker {
  private queues: Record<ChatMode, Waiter[]> = { video: [], text: [] };

  /** sessionId -> (partnerSessionId -> expiry). Prevents instant rematches. */
  private recentPartners = new Map<string, Map<string, number>>();

  private timer: NodeJS.Timeout | null = null;

  /** Returns false if the socket has gone away since it was queued. */
  private readonly isAlive: (socketId: string) => boolean;
  private readonly onPaired: (pairing: Pairing) => void;

  constructor(
    isAlive: (socketId: string) => boolean,
    onPaired: (pairing: Pairing) => void,
  ) {
    this.isAlive = isAlive;
    this.onPaired = onPaired;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), config.matchmaking.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(waiter: Omit<Waiter, 'queuedAt'>, { priority = false } = {}): void {
    this.dequeue(waiter.socketId);
    const entry: Waiter = { ...waiter, queuedAt: Date.now() };
    // A user who was skipped (not the skipper) goes to the front, so being
    // skipped does not also cost them their place in line.
    if (priority) this.queues[waiter.mode].unshift(entry);
    else this.queues[waiter.mode].push(entry);
  }

  dequeue(socketId: string): void {
    for (const mode of CHAT_MODES) {
      const idx = this.queues[mode].findIndex((w) => w.socketId === socketId);
      if (idx !== -1) this.queues[mode].splice(idx, 1);
    }
  }

  position(socketId: string): { position: number; waitingInMode: number } {
    for (const mode of CHAT_MODES) {
      const idx = this.queues[mode].findIndex((w) => w.socketId === socketId);
      if (idx !== -1) return { position: idx + 1, waitingInMode: this.queues[mode].length };
    }
    return { position: 0, waitingInMode: 0 };
  }

  /** Record that two sessions have just met, so we avoid pairing them again soon. */
  rememberPair(a: string, b: string): void {
    this.remember(a, b);
    this.remember(b, a);
  }

  private remember(sessionId: string, partnerId: string): void {
    let seen = this.recentPartners.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.recentPartners.set(sessionId, seen);
    }
    seen.set(partnerId, Date.now() + config.matchmaking.recentPartnerTtlMs);

    // Keep only the most recent N entries.
    while (seen.size > config.matchmaking.recentPartnerMax) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  forgetSession(sessionId: string): void {
    this.recentPartners.delete(sessionId);
  }

  private metRecently(a: string, b: string): boolean {
    const expiry = this.recentPartners.get(a)?.get(b);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.recentPartners.get(a)?.delete(b);
      return false;
    }
    return true;
  }

  private tick(): void {
    for (const mode of CHAT_MODES) this.drain(mode);
  }

  private drain(mode: ChatMode): void {
    const queue = this.queues[mode];
    if (queue.length < 2) return;

    // Drop anyone whose socket died while queued, so nobody is matched to a ghost.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!this.isAlive(queue[i]!.socketId)) queue.splice(i, 1);
    }

    const claimed = new Set<string>();
    const pairs: Array<[Waiter, Waiter]> = [];

    for (let i = 0; i < queue.length; i++) {
      const a = queue[i]!;
      if (claimed.has(a.socketId)) continue;

      for (let j = i + 1; j < queue.length; j++) {
        const b = queue[j]!;
        if (claimed.has(b.socketId)) continue;
        if (a.sessionId === b.sessionId) continue;

        // Normally refuse a rematch — unless both have waited long enough that
        // seeing a familiar face beats waiting alone in an empty queue.
        if (this.metRecently(a.sessionId, b.sessionId) && !this.waitedLongEnough(a, b)) {
          continue;
        }

        claimed.add(a.socketId);
        claimed.add(b.socketId);
        pairs.push([a, b]);
        break;
      }
    }

    if (pairs.length === 0) return;

    for (let i = queue.length - 1; i >= 0; i--) {
      if (claimed.has(queue[i]!.socketId)) queue.splice(i, 1);
    }

    for (const [a, b] of pairs) {
      // Re-check liveness immediately before announcing: a socket can drop
      // between the sweep above and this line.
      if (!this.isAlive(a.socketId) || !this.isAlive(b.socketId)) {
        if (this.isAlive(a.socketId)) this.enqueue(a, { priority: true });
        if (this.isAlive(b.socketId)) this.enqueue(b, { priority: true });
        continue;
      }

      const pairing: Pairing = {
        roomId: crypto.randomUUID(),
        mode,
        initiator: a,
        responder: b,
      };

      this.rememberPair(a.sessionId, b.sessionId);

      appendJsonl(files.pairings, {
        roomId: pairing.roomId,
        mode,
        sessions: [a.sessionId, b.sessionId],
        waitedMs: [Date.now() - a.queuedAt, Date.now() - b.queuedAt],
      });

      this.onPaired(pairing);
    }
  }

  private waitedLongEnough(a: Waiter, b: Waiter): boolean {
    const threshold = config.matchmaking.rematchFallbackMs;
    const now = Date.now();
    return now - a.queuedAt > threshold && now - b.queuedAt > threshold;
  }

  stats(): Record<ChatMode, number> {
    return { video: this.queues.video.length, text: this.queues.text.length };
  }

  /** Expire stale recent-partner entries so the map does not grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [sessionId, seen] of this.recentPartners) {
      for (const [partnerId, expiry] of seen) {
        if (expiry <= now) seen.delete(partnerId);
      }
      if (seen.size === 0) this.recentPartners.delete(sessionId);
    }
  }
}
