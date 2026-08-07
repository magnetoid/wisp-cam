# c2c — anonymous random video & text chat

One-on-one video or text with a stranger. No accounts, no chat history. Swipe up for someone new.

Mobile-first: the stage fills the viewport, and the primary gesture is a **swipe up to skip** to
the next person, with a Next button for desktop and accessibility.

## How it works

```
Browser A  ──HTTPS──▶  static SPA           (Cloudflare Pages)
Browser A  ──WSS────▶  signaling server     (Fly.io — matchmaking + SDP/ICE relay + text relay)
Browser A ◀──SRTP───▶  Browser B            (direct P2P, or relayed via Cloudflare TURN)
```

Video and audio flow **directly between the two browsers**. The server never sees media — it
only introduces the two peers and forwards their connection handshake. That keeps bandwidth
costs near zero and means there is no media on our infrastructure to leak or subpoena.

Text is deliberately **relayed through the server** rather than sent over a WebRTC data channel.
That is a conscious trade: a data channel would be end-to-end encrypted and invisible to us, but
it would also make spam filtering and abuse evidence impossible. Messages are filtered in memory
and never written to disk.

### Repository layout

| Path | What it is |
|---|---|
| [shared/protocol.ts](shared/protocol.ts) | The wire protocol both sides import — the single source of truth for events |
| [server/src/matchmaker.ts](server/src/matchmaker.ts) | FIFO queues, the 200 ms pairing loop, recent-partner avoidance |
| [server/src/index.ts](server/src/index.ts) | HTTP routes, socket auth, signaling relay, room lifecycle |
| [server/src/safety/](server/src/safety/) | Bans, rate limiting, text filtering |
| [client/src/lib/peer.ts](client/src/lib/peer.ts) | One `RTCPeerConnection` per pairing, built and torn down per match |
| [client/src/lib/useChat.ts](client/src/lib/useChat.ts) | Client state machine tying socket, peer and media together |
| [client/src/lib/useSwipe.ts](client/src/lib/useSwipe.ts) | The swipe-up-to-next gesture |

### Design decisions worth knowing

- **Peer-to-peer, not an SFU.** For 1:1 there is no reason to route media through a server.
- **The server picks the initiator.** Exactly one side of each pair is told to create the offer,
  so offer collision ("glare") cannot happen and no negotiation-rollback logic is needed.
- **A pairing gets a fresh `RTCPeerConnection`, always.** Reusing a connection across partners is
  the most common source of wedged state in random-chat apps.
- **The camera stream outlives the pairing.** Acquired once and kept, so skipping to the next
  person is instant and doesn't re-prompt for permission.
- **Matching runs on a loop, not on arrival.** A 200 ms loop applies liveness and
  recent-partner rules to everyone waiting, instead of racing whoever connected first.
- **Being skipped doesn't cost your place in line.** The skipped user is re-queued at the front,
  the skipper at the back.

## Running locally

```bash
npm install
cp .env.example .env        # optional; sensible dev defaults are built in
npm run dev                 # server on :8080, client on :5173
```

Open http://localhost:5173 in two tabs. `localhost` counts as a secure origin, so the camera
works without HTTPS. In development the bot check is skipped and TURN falls back to public STUN,
which is fine for two machines on the same network.

```bash
npm test          # 19 end-to-end tests against a real server process
npm run typecheck
npm run build
```

The test suite spawns its own server on a throwaway port and data directory, and drives the real
wire protocol with real socket.io clients — pairing, teardown, requeueing and abuse handling are
all about how two connections interleave, which unit tests of the queue alone would not catch.

### Testing on a phone

The camera requires HTTPS on anything other than `localhost`. Use a tunnel:

```bash
npx localtunnel --port 5173     # or: cloudflared tunnel --url http://localhost:5173
```

## Deploying

**Signaling server → Fly.io** (~$3–5/month). Matchmaking state lives in the process's memory, so
it must not scale to zero and should stay a single machine until you add a Redis adapter.

```bash
fly launch --no-deploy --copy-config
fly volumes create c2c_data --size 1
fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly secrets set TURNSTILE_SECRET=... CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=...
fly deploy
```

**Frontend → Cloudflare Pages** (free). Build command `npm run build --workspace=client`, output
directory `client/dist`, and set `VITE_SERVER_URL` to the Fly hostname.

**TURN → Cloudflare Realtime** (free up to 1,000 GB/month, then $0.05/GB). This is **not
optional**: roughly 15–20% of consumer connections cannot traverse NAT directly, and more on
mobile carrier networks. Without TURN, about one match in five silently fails to connect.

Verify TURN actually works before launch by forcing relay-only mode — set
`iceTransportPolicy: 'relay'` in [peer.ts](client/src/lib/peer.ts) temporarily; if video still
connects, TURN is configured correctly. `PeerSession.selectedCandidateType()` reports which
candidate type won.

Expected cost at hobby scale: **~$5/month total.**

## Safety

Omegle shut down in 2023 after a lawsuit that attacked its *design* — random pairing of adults
with unverified minors and minimal proactive safety — rather than any particular piece of user
content. Section 230 did not shield it, because the claim was product liability, not publication.
Anyone running this category of site inherits that exposure. The baseline below is implemented,
and it is a floor, not a finish line.

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
- IP and pairing metadata retained 30 days and auto-pruned; **no chat content or media is ever
  stored**
- Terms and a privacy policy that describe what the service actually does

### Known gaps — read before launching publicly

These are deliberate MVP trade-offs, not oversights:

1. **On-device NSFW screening is bypassable.** Anyone who opens devtools can disable it. It stops
   casual flashers, not determined ones. The upgrade path is server-side sampled-frame scanning
   (Sightengine has a free tier, ~$29/month beyond it); in a P2P design this requires clients to
   upload sampled frames.
2. **Self-declared age is not age verification.** Under the UK Online Safety Act, services likely
   to be accessed by children must use "highly effective age assurance"; a date field is not that,
   and Ofcom has said small high-risk services are squarely in scope, with penalties up to £18M or
   10% of global turnover. **The owner of this deployment has chosen to launch without a UK
   geo-block.** Blocking UK traffic is a one-rule change at the Cloudflare edge and is the cheapest
   mitigation if that decision is revisited.
3. **Register an NCMEC CyberTipline point of contact before going public.** It's free. US law
   requires reporting apparent child sexual abuse material, child sex trafficking and enticement
   once you have actual knowledge, and preserving the material for a year. There is a written
   procedure for this in the terms; make sure a human is actually behind the abuse address.
4. **No human review queue.** Reports land in `data/reports.jsonl`. Someone has to read them.
5. **Single process, in-memory queue.** Fine to a few thousand concurrent users. Beyond that, move
   the queue and the socket.io adapter to Redis.
6. **The terms and privacy policy are a starting point, not legal advice.** Have a lawyer read
   them before a public launch.

## License

MIT
