/**
 * End-to-end tests against a live server process.
 *
 * These drive the real wire protocol with real socket.io clients, because the
 * parts most likely to break — pairing, teardown on skip, requeueing — are all
 * about how two connections interleave, which unit tests of the queue alone
 * would not catch.
 *
 * Run with: npm test --workspace=server
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';

const PORT = Number(process.env.TEST_PORT ?? 8099);
const SERVER = `http://localhost:${PORT}`;
const ADULT_DOB = '1990-05-05';

const serverEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

let serverProcess: ChildProcess | null = null;
let dataDir = '';

/**
 * Each run gets a throwaway data directory. The reporting test bans the
 * loopback address, which would otherwise lock out every subsequent run.
 */
async function startServer(): Promise<void> {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-test-'));

  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      JWT_SECRET: 'test-secret-not-for-production',
      NODE_ENV: 'test',
      // Every client in this suite comes from the loopback address, so the
      // real per-IP limits would throttle the suite rather than the tests.
      SESSIONS_PER_IP_PER_HOUR: '5000',
      JOINS_PER_MINUTE: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('test server did not become healthy in time');
}

function stopServer(): void {
  serverProcess?.kill('SIGTERM');
  serverProcess = null;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

async function createSession(): Promise<string> {
  const res = await fetch(`${SERVER}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ birthDate: ADULT_DOB }),
  });
  assert.equal(res.status, 200, `session creation failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { auth: { token }, transports: ['websocket'], forceNew: true });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timed out')), 5000);
  });
}

/** Resolves with the first payload of `event`, or rejects on timeout. */
function once<T = unknown>(socket: Socket, event: string, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

interface MatchFound {
  roomId: string;
  isInitiator: boolean;
  mode: string;
}

const openSockets: Socket[] = [];

async function newClient(): Promise<Socket> {
  const socket = await connect(await createSession());
  openSockets.push(socket);
  return socket;
}

/** Puts two fresh clients into the same queue and waits for them to be paired. */
async function pairTwo(mode: 'video' | 'text' = 'text'): Promise<{
  a: Socket;
  b: Socket;
  matchA: MatchFound;
  matchB: MatchFound;
}> {
  const a = await newClient();
  const b = await newClient();

  const matchAPromise = once<MatchFound>(a, 'match:found');
  const matchBPromise = once<MatchFound>(b, 'match:found');

  a.emit('queue:join', { mode });
  b.emit('queue:join', { mode });

  const [matchA, matchB] = await Promise.all([matchAPromise, matchBPromise]);
  return { a, b, matchA, matchB };
}

describe('c2c signaling server', () => {
  before(async () => {
    await startServer();
  });

  /**
   * Clear the queues between tests. A client left waiting by an earlier test
   * would otherwise be matched with the next test's first client, so the pair
   * under test would never actually be paired with each other.
   */
  afterEach(async () => {
    for (const socket of openSockets) socket.disconnect();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  after(() => {
    for (const socket of openSockets) socket.disconnect();
    stopServer();
  });

  describe('session gate', () => {
    it('issues a token to an adult', async () => {
      const token = await createSession();
      assert.ok(token.length > 20);
    });

    it('refuses an under-18 date of birth', async () => {
      const recent = new Date();
      recent.setFullYear(recent.getFullYear() - 14);
      const res = await fetch(`${SERVER}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ birthDate: recent.toISOString().slice(0, 10) }),
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, 'age-requirement');
    });

    it('refuses a malformed date of birth', async () => {
      const res = await fetch(`${SERVER}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ birthDate: 'not-a-date' }),
      });
      assert.equal(res.status, 403);
    });

    it('refuses a socket connection without a valid token', async () => {
      await assert.rejects(
        () => connect('garbage-token'),
        (err: Error) => err.message === 'unauthorized',
      );
    });

    it('refuses ICE credentials without a token', async () => {
      const res = await fetch(`${SERVER}/api/ice`);
      assert.equal(res.status, 401);
    });
  });

  describe('matchmaking', () => {
    it('pairs two waiting users and names exactly one initiator', async () => {
      const { matchA, matchB } = await pairTwo();

      assert.equal(matchA.roomId, matchB.roomId, 'both sides must share a room id');
      assert.notEqual(
        matchA.isInitiator,
        matchB.isInitiator,
        'exactly one side must be the initiator, or the offers collide',
      );
    });

    it('does not pair a lone user with themselves', async () => {
      const solo = await newClient();
      solo.emit('queue:join', { mode: 'text' });
      await assert.rejects(() => once(solo, 'match:found', 1200));
    });

    it('keeps video and text users in separate pools', async () => {
      const videoUser = await newClient();
      const textUser = await newClient();

      videoUser.emit('queue:join', { mode: 'video' });
      textUser.emit('queue:join', { mode: 'text' });

      await assert.rejects(() => once(videoUser, 'match:found', 1200));
    });
  });

  describe('signaling relay', () => {
    it('forwards descriptions and candidates to the partner only', async () => {
      const { a, b } = await pairTwo();

      const description = { type: 'offer' as const, sdp: 'v=0\r\no=- test\r\n' };
      const descPromise = once<{ description: typeof description }>(b, 'signal:description');
      a.emit('signal:description', { description });
      assert.deepEqual((await descPromise).description, description);

      const candidate = { candidate: 'candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host', sdpMid: '0' };
      const candPromise = once<{ candidate: typeof candidate }>(b, 'signal:candidate');
      a.emit('signal:candidate', { candidate });
      assert.deepEqual((await candPromise).candidate, candidate);
    });

    it('drops signaling from an unpaired socket instead of broadcasting it', async () => {
      const { b } = await pairTwo();
      const stranger = await newClient();

      let leaked = false;
      b.on('signal:description', () => {
        leaked = true;
      });
      stranger.emit('signal:description', { description: { type: 'offer', sdp: 'leak' } });

      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(leaked, false, 'signaling must never reach a non-partner');
    });
  });

  describe('text chat', () => {
    it('relays a clean message', async () => {
      const { a, b } = await pairTwo();
      const received = once<{ text: string }>(b, 'chat:message');
      a.emit('chat:send', { text: 'hey, how is your day going', clientId: 1 });
      assert.equal((await received).text, 'hey, how is your day going');
    });

    it('blocks links and says which message was refused', async () => {
      const { a, b } = await pairTwo();

      let delivered = false;
      b.on('chat:message', () => {
        delivered = true;
      });

      const blocked = once<{ reason: string; clientId: number }>(a, 'chat:blocked');
      a.emit('chat:send', { text: 'check out https://spam.example.com now', clientId: 7 });

      const verdict = await blocked;
      assert.equal(verdict.reason, 'link');
      assert.equal(verdict.clientId, 7, 'the sender must be told which message was refused');
      assert.equal(delivered, false, 'a blocked message must never reach the partner');
    });

    it('blocks contact details', async () => {
      const { a } = await pairTwo();
      const blocked = once<{ reason: string }>(a, 'chat:blocked');
      a.emit('chat:send', { text: 'add me on snapchat coolguy99', clientId: 8 });
      assert.equal((await blocked).reason, 'contact-info');
    });

    it('blocks an over-long message', async () => {
      const { a } = await pairTwo();
      const blocked = once<{ reason: string }>(a, 'chat:blocked');
      a.emit('chat:send', { text: 'x'.repeat(2500), clientId: 9 });
      assert.equal((await blocked).reason, 'too-long');
    });
  });

  describe('skip and disconnect', () => {
    it('tells the partner why the chat ended and requeues them', async () => {
      const { a, b } = await pairTwo();

      const leftPromise = once<{ reason: string }>(b, 'peer:left');
      const waitingPromise = once<{ position: number }>(b, 'queue:waiting');
      a.emit('peer:skip');

      assert.equal((await leftPromise).reason, 'skipped');
      assert.ok((await waitingPromise).position >= 1, 'the skipped user goes back in line');
    });

    it('notifies the survivor when a partner drops', async () => {
      const { a, b } = await pairTwo();
      const leftPromise = once<{ reason: string }>(b, 'peer:left');
      a.disconnect();
      assert.equal((await leftPromise).reason, 'disconnected');
    });

    it('rematches both sides with someone new after a skip', async () => {
      // Four in the pool, so both halves of the broken pair have someone left
      // to match with. With only three, one user is necessarily left waiting.
      const { a, b, matchA } = await pairTwo();
      const c = await newClient();
      const d = await newClient();

      const aMatch = once<MatchFound>(a, 'match:found', 8000);
      const bMatch = once<MatchFound>(b, 'match:found', 8000);

      c.emit('queue:join', { mode: 'text' });
      d.emit('queue:join', { mode: 'text' });
      a.emit('peer:skip');

      const [nextA, nextB] = await Promise.all([aMatch, bMatch]);

      assert.notEqual(nextA.roomId, matchA.roomId, 'the skipper must land in a new room');
      assert.notEqual(
        nextA.roomId,
        nextB.roomId,
        'the two must not be put straight back together after a skip',
      );
    });

    it('survives repeated skipping without wedging', async () => {
      const { a } = await pairTwo();
      for (let i = 0; i < 10; i++) a.emit('peer:skip');

      await new Promise((resolve) => setTimeout(resolve, 800));
      const res = await fetch(`${SERVER}/health`);
      assert.ok(res.ok, 'server must stay healthy under skip-hammering');
    });
  });

  describe('reporting', () => {
    it('ends the chat and disconnects the reported user for severe reasons', async () => {
      const { a, b } = await pairTwo();

      const bannedPromise = once<{ reason: string }>(b, 'session:banned');
      a.emit('peer:report', { reason: 'nudity' });

      const banned = await bannedPromise;
      assert.equal(banned.reason, 'reported');
    });
  });
});
