# Deploying Wisp Cam on Coolify

Target: **wisp.best** (app) and **api.wisp.best** (signaling), with a self-hosted
TURN relay on **turn.wisp.best**.

Two separate Coolify resources. coturn cannot live in the app stack — it needs raw
UDP and host networking, so the reverse proxy can't carry it, and keeping it apart
means app redeploys don't drop live relayed calls.

---

## 0. DNS

Point all three at the server's public IPv4:

| Record | Type | Value |
|---|---|---|
| `wisp.best` | A | your server IP |
| `api.wisp.best` | A | your server IP |
| `turn.wisp.best` | A | your server IP |

## 1. Firewall

Coolify's Traefik already owns 80/tcp, 443/tcp, 443/udp and 8080/tcp. TURN needs
its own ports opened — and because coturn uses host networking, Docker does *not*
bypass your firewall for it, so these rules genuinely apply:

```bash
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 50000:50500/udp
```

Open the same range in your provider's security group (Hetzner Cloud Firewall, AWS
security group, etc.) — that's a separate layer and a common thing to miss.

> **TURN on port 443 is not possible here.** Traefik holds 443 on both TCP and UDP
> (HTTP/3). Clients on networks that only permit 443 will fail to relay. If that
> matters, add a second IPv4 to the VPS and bind coturn's TLS listener to it, or
> run coturn on a separate host.

## 2. Generate secrets

```bash
# Signs anonymous session tokens
openssl rand -hex 32

# Shared with coturn; never reaches the browser
openssl rand -hex 32
```

## 3. Deploy coturn first

The app needs `TURN_STATIC_AUTH_SECRET` to match, so bring this up first.

**New Resource → Docker Compose Empty**, paste
[`deploy/coolify/coturn.compose.yml`](coolify/coturn.compose.yml), and set:

| Variable | Value |
|---|---|
| `TURN_REALM` | `turn.wisp.best` |
| `TURN_EXTERNAL_IP` | the server's public IPv4 |
| `TURN_STATIC_AUTH_SECRET` | the second secret from step 2 |

**Assign no domain to this resource.** It is not behind the proxy, and a domain
would do nothing.

Verify after deploy:

```bash
docker compose logs coturn | grep -i "relay
\|listener"     # should show listeners on 3478/5349
```

## 4. Deploy the app

**New Resource → Docker Compose** from the Git repo, with
**Docker Compose Location** = `deploy/coolify/app.compose.yml`.

### Domains

In the resource's **General** tab, per service:

| Field | Value |
|---|---|
| Domains for `web` | `https://wisp.best:80` |
| Domains for `signaling` | `https://api.wisp.best:8080` |

Two details that cause most first-deploy failures:

- **The scheme must be `https://`.** `http://` creates only an HTTP router, no TLS
  and no certificate — and `wss://` then cannot work.
- **The `:port` suffix is not part of the public URL.** It is the only thing that
  tells Traefik which container port to route to. Leave it off and Traefik guesses
  the lowest exposed port, which produces a 502.

### Environment variables

| Variable | Value | Build var? |
|---|---|---|
| `JWT_SECRET` | first secret from step 2 | no |
| `VITE_SERVER_URL` | `https://api.wisp.best` | **yes** |
| `TURN_URLS` | `turn:turn.wisp.best:3478?transport=udp,turn:turn.wisp.best:3478?transport=tcp,turns:turn.wisp.best:5349?transport=tcp` | no |
| `TURN_STATIC_AUTH_SECRET` | second secret from step 2 — must match coturn exactly | no |
| `TURNSTILE_SECRET` | from Cloudflare Turnstile | no |
| `TURNSTILE_SITE_KEY` | from Cloudflare Turnstile | no |
| `ABUSE_CONTACT_EMAIL` | a mailbox someone actually reads | no |

**`VITE_SERVER_URL` must have "Build Variable" ticked.** Vite inlines `VITE_*`
values into the bundle at build time; if the flag is off the variable resolves to
empty during the build and the app ships pointing at nothing — with no build error
to warn you.

Conversely, leave "Build Variable" **off** for `TURN_STATIC_AUTH_SECRET` and
`JWT_SECRET`: build args are recorded in image metadata and visible in
`docker history`.

### Turn OFF gzip compression for `signaling`

In the resource's **Advanced** settings, disable **Enable Gzip Compression**.

Traefik's compression middleware buffers socket.io's HTTP long-polling leg and
breaks the connection upgrade. This client already forces
`transports: ['websocket']`, which sidesteps it, but leaving gzip on is a trap for
any future change that re-enables polling — and it's the single most common cause
of "WebSockets don't work behind Coolify".

## 5. Verify the deployment

```bash
curl https://api.wisp.best/health
# {"ok":true,"queues":{"video":0,"text":0},"rooms":0}
```

Then, in order:

1. **Open https://wisp.best on two devices** — ideally a phone on mobile data and a
   laptop on Wi-Fi, which forces real NAT traversal rather than a LAN shortcut.
2. **Confirm TURN actually works.** This is the step people skip and regret: without
   a working relay roughly one connection in five fails, and it fails silently.
   Paste the output of `curl -H "Authorization: Bearer <token>" https://api.wisp.best/api/ice`
   into the [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
   **You must see at least one candidate of type `relay`.** Only `host` and `srflx`
   means TURN is not working, whatever the logs say.
3. **Check the reports volume survives a redeploy** — redeploy and confirm
   `/data/reports.jsonl` is still there. Renaming the volume in the compose file
   orphans the old data, so treat `wisp-data` as immutable.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 502 on `api.wisp.best` | Missing `:8080` in the domain field — Traefik guessed the port |
| Certificate errors / no TLS | Domain entered as `http://` instead of `https://` |
| WebSocket connects then drops | Gzip compression still enabled on `signaling` |
| Video connects on LAN, fails across networks | TURN not reachable — check firewall and `external-ip` |
| App loads but nothing connects | `VITE_SERVER_URL` wasn't a build variable; bundle has an empty API URL |
| CORS errors in console | `ALLOWED_ORIGINS` doesn't match the `web` domain exactly (scheme included) |
| `network_mode` error on coturn | Known Coolify bug on *existing* resources — delete and recreate the resource |

## Before you point real users at it

- Register an NCMEC CyberTipline point of contact (free) and put a human behind
  `ABUSE_CONTACT_EMAIL`. Reports land in `/data/reports.jsonl` and nothing reads
  them for you.
- See the "Known gaps" section in the [README](../README.md) — particularly that
  on-device NSFW screening is bypassable, and that a self-declared age gate is not
  age verification under the UK Online Safety Act.
