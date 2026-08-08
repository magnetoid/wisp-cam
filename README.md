# Wisp Cam

**[wisp.best](https://wisp.best)** — one-on-one video or text with a stranger. No accounts, no chat
history. Swipe up for someone new.

Mobile-first: the stage fills the viewport, and the primary gesture is a **swipe up to skip** to the
next person, with a Next button for desktop and accessibility.

## How it works

```
Browser A  ──HTTPS──▶  static SPA        (nginx)   wisp.best
Browser A  ──WSS────▶  signaling server  (Node)    api.wisp.best
Browser A ◀──SRTP───▶  Browser B         direct P2P, or relayed via coturn (turn.wisp.best)
```

Video and audio flow **directly between the two browsers**. The server never sees media — it only
introduces the two peers and forwards their connection handshake. That keeps bandwidth costs near
zero and means there is no media on our infrastructure to leak or subpoena.

Text is deliberately **relayed through the server** rather than sent over a WebRTC data channel.
That is a conscious trade: a data channel would be end-to-end encrypted and invisible to us, but it
would also make spam filtering and abuse evidence impossible. Messages are filtered in memory and
never written to disk.

### Repository layout

| Path | What it is |
|---|---|
| [shared/protocol.ts](shared/protocol.ts) | The wire protocol both sides import — the single source of truth for events |
| [server/src/matchmaker.ts](server/src/matchmaker.ts) | FIFO queues, the 200 ms pairing loop, recent-partner avoidance |
| [server/src/index.ts](server/src/index.ts) | HTTP routes, socket auth, signaling relay, room lifecycle |
| [server/src/turn.ts](server/src/turn.ts) | Mints time-limited TURN credentials (coturn HMAC, or Cloudflare) |
| [server/src/safety/](server/src/safety/) | Bans, rate limiting, text filtering |
| [client/src/lib/peer.ts](client/src/lib/peer.ts) | One `RTCPeerConnection` per pairing, built and torn down per match |
| [client/src/lib/useChat.ts](client/src/lib/useChat.ts) | Client state machine tying socket, peer and media together |
| [client/src/lib/useSwipe.ts](client/src/lib/useSwipe.ts) | The swipe-up-to-next gesture |
| [deploy/COOLIFY.md](deploy/COOLIFY.md) | Step-by-step production deployment |

### Design decisions worth knowing

- **Peer-to-peer, not an SFU.** For 1:1 there is no reason to route media through a server.
- **The server picks the initiator.** Exactly one side of each pair is told to create the offer, so
  offer collision ("glare") cannot happen and no negotiation-rollback logic is needed.
- **A pairing gets a fresh `RTCPeerConnection`, always.** Reusing a connection across partners is the
  most common source of wedged state in random-chat apps.
- **The camera stream outlives the pairing.** Acquired once and kept, so skipping to the next person
  is instant and doesn't re-prompt for permission.
- **Matching runs on a loop, not on arrival.** A 200 ms loop applies liveness and recent-partner
  rules to everyone waiting, instead of racing whoever connected first.
- **Being skipped doesn't cost your place in line.** The skipped user is re-queued at the front, the
  skipper at the back.
- **Intent is tracked separately from connection state.** A phone that changes network or wakes from
  background gets a new socket; the client remembers what the user *wanted* and rejoins the queue,
  rather than sitting on a "Searching" screen while queued nowhere.
- **Recent partners are remembered per session, not per socket**, so reconnecting doesn't hand you
  straight back to the person you just left.

## Running locally

```bash
npm install
cp .env.example .env        # optional; sensible dev defaults are built in
npm run dev                 # server on :8080, client on :5173
```

Open http://localhost:5173 in two tabs. `localhost` counts as a secure origin, so the camera works
without HTTPS. In development the bot check is skipped and TURN falls back to public STUN, which is
fine for two machines on the same network.

```bash
npm test          # 20 end-to-end tests against a real server process
npm run typecheck
npm run build
```

The test suite spawns its own server on a throwaway port and data directory, and drives the real wire
protocol with real socket.io clients — pairing, teardown, requeueing, reconnection and abuse handling
are all about how two connections interleave, which unit tests of the queue alone would not catch.

### Testing on a phone

The camera requires HTTPS on anything other than `localhost`. Use a tunnel:

```bash
npx localtunnel --port 5173     # or: cloudflared tunnel --url http://localhost:5173
```

## Deploying

**Production target is Coolify** — see **[deploy/COOLIFY.md](deploy/COOLIFY.md)** for the full
walkthrough, including the handful of Coolify-specific settings that will otherwise cost you an
afternoon (the `:port` suffix on domains, the gzip toggle that breaks WebSockets, and marking
`VITE_SERVER_URL` as a build variable).

For a plain Docker host, [docker-compose.yml](docker-compose.yml) brings up all three services:

```bash
cp .env.example .env        # set JWT_SECRET, TURN_STATIC_AUTH_SECRET, TURN_EXTERNAL_IP
docker compose up -d --build
```

Put a TLS terminator in front of it — `getUserMedia` refuses to run on anything but HTTPS or
localhost.

### TURN is not optional

Roughly 15–20% of consumer connections cannot traverse NAT directly, and more on mobile carrier
networks. Without a relay, about one match in five fails to connect — silently.

The stack self-hosts **coturn**, with the signaling server minting time-limited HMAC credentials so
no secret ever reaches the browser. Set `CLOUDFLARE_TURN_*` instead to use Cloudflare Realtime TURN
(1,000 GB/month free) and leave `TURN_URLS` unset.

**Verify the relay before launch.** Feed `/api/ice` output into the
[Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) and
confirm at least one candidate of type `relay` appears. Only `host` and `srflx` means TURN is not
working, regardless of what the logs say.

Expected cost: a single small VPS running Coolify, ~€5/month all in.

## Safety

Omegle shut down in 2023 after a lawsuit that attacked its *design* — random pairing of adults with
unverified minors and minimal proactive safety — rather than any particular piece of user content.
Section 230 did not shield it, because the claim was product liability, not publication. Anyone
running this category of site inherits that exposure. The baseline below is implemented, and it is a
floor, not a finish line.

**What ships here:**

- Neutral date-of-birth age gate, re-checked server-side so editing the client can't bypass it
- Cloudflare Turnstile bot gate → short-lived signed session token required for any socket
- Per-IP and per-session rate limits on sessions, matching and messages
- Report button with reason codes; a still frame of the reported peer is captured **only** at the
  moment of a report, as evidence
- Severe reports (nudity, apparent minor, illegal) ban and disconnect immediately; others are
  recorded for human review
- Escalating IP bans: 15 minutes → 24 hours → permanent
- On-device NSFW screening of your **own** camera (NSFWJS/MobileNetV2), auto-disconnecting on
  repeated high-confidence detections
- Server-side text filtering for profanity, links, and contact details (the main vector for
  off-platform luring)
- TURN credentials scoped to a session id, so relay usage is traceable when handling a report
- coturn refuses to relay to private address space — an open TURN server is otherwise a proxy into
  the host's own network
- IP and pairing metadata retained 30 days and auto-pruned; **no chat content or media is ever
  stored**
- Terms and a privacy policy that describe what the service actually does

### Known gaps — read before launching publicly

These are deliberate MVP trade-offs, not oversights:

1. **On-device NSFW screening is bypassable.** Anyone who opens devtools can disable it. It stops
   casual flashers, not determined ones. The upgrade path is server-side sampled-frame scanning
   (Sightengine has a free tier, ~$29/month beyond it); in a P2P design this requires clients to
   upload sampled frames.
2. **Self-declared age is not age verification.** Under the UK Online Safety Act, services likely to
   be accessed by children must use "highly effective age assurance"; a date field is not that, and
   Ofcom has said small high-risk services are squarely in scope, with penalties up to £18M or 10% of
   global turnover. **This deployment launches without a UK geo-block** — a deliberate, accepted
   risk. Blocking UK traffic is a one-rule change at the edge if that decision is revisited.
3. **Register an NCMEC CyberTipline point of contact before going public.** It's free. US law requires
   reporting apparent child sexual abuse material, child sex trafficking and enticement once you have
   actual knowledge, and preserving the material for a year. There is a written procedure in the
   terms; make sure a human is actually behind the abuse address.
4. **No human review queue.** Reports land in `/data/reports.jsonl`. Someone has to read them.
5. **Single process, in-memory queue.** Fine to a few thousand concurrent users. Beyond that, move
   the queue and the socket.io adapter to Redis — and note that Coolify emits no sticky-session
   labels, so a second replica needs the Redis adapter to work at all.
6. **TURN cannot use port 443** on a Coolify host, because Traefik holds it. Clients on networks that
   permit only 443 will fail to relay.
7. **The terms and privacy policy are a starting point, not legal advice.** Have a lawyer read them
   before a public launch.

## License

MIT
