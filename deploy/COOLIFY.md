# Deploying Wisp Cam

This documents the **live production setup** on `wisp.best`, as actually deployed
and verified — not a generic recipe.

## The request path

```
browser ──▶ Cloudflare DNS (grey cloud, no proxy)
        ──▶ Plesk nginx :443        TLS termination, Let's Encrypt
        ──▶ Coolify Caddy :8445     routes by Host header
        ──▶ container               web :80 / signaling :8080

browser ◀────────── SRTP ──────────▶ browser      direct peer-to-peer
browser ◀── coturn :3478/:5349 ────▶ browser      when NAT blocks direct
```

Two things about this host differ from a stock Coolify box, and both matter:

- **Plesk nginx owns ports 80 and 443**, not Coolify's proxy. Coolify's Caddy sits
  behind it on `8090` (HTTP) and `8445` (HTTPS). Domains are therefore wired up in
  *two* places: an nginx vhost, and the Coolify service domain.
- **`iptables` INPUT policy is DROP**, managed by the Plesk firewall extension.
  Any new port must be opened explicitly or it is silently unreachable.

## DNS (Cloudflare)

All records point to `65.21.238.89` and are **DNS-only (grey cloud)**:

| Record | Type | Value |
|---|---|---|
| `wisp.best` | A | 65.21.238.89 |
| `api.wisp.best` | A | 65.21.238.89 |
| `turn.wisp.best` | A | 65.21.238.89 |
| `www.wisp.best` | CNAME | wisp.best |

**Do not enable the orange cloud without changing the app first.** With Cloudflare
proxying, every request arrives from a Cloudflare IP, so the per-IP rate limits and
bans would apply to Cloudflare rather than to users — effectively disabling them.
`turn.wisp.best` can never be proxied: TURN is not HTTP.

## TLS

One certificate covers all four names, issued via the existing Cloudflare DNS
plugin (no port-80 dependency):

```bash
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.cloudflare.ini \
  -d wisp.best -d www.wisp.best -d api.wisp.best -d turn.wisp.best \
  --cert-name wisp.best
```

## nginx vhost

`/etc/nginx/conf.d/wisp.best.conf` terminates TLS and forwards to Caddy on 8445.
It must carry the WebSocket upgrade headers or signaling silently fails, and it
raises `proxy_read_timeout` because signaling connections are long-lived and mostly
idle — the 60s default would cut chats off mid-conversation.

## Firewall

TURN ports opened through Plesk so they survive a firewall re-apply:

```bash
plesk ext firewall --set-rule -name "Wisp Cam TURN" -direction input -action allow \
  -ports "3478/tcp,3478/udp,5349/tcp,5349/udp,50000-50500/udp"
plesk ext firewall --apply
plesk ext firewall --confirm      # from a second SSH session
```

## coturn

Runs outside Coolify at `/opt/wisp-coturn` (`docker compose`), because it needs host
networking and raw UDP and cannot sit behind any HTTP proxy.

Two things that will bite you:

- **coturn drops privileges to `nobody`.** Its config file and certificates must be
  readable by uid 65534. A root-owned `600` config is silently ignored and coturn
  starts with *defaults* — no realm, no auth secret, no TLS. Check the logs for
  `Cannot find config file`.
- **`/etc/letsencrypt/live` is root-only**, so certificates are copied to
  `/opt/wisp-coturn/certs` owned by 65534. A deploy hook at
  `/etc/letsencrypt/renewal-hooks/deploy/wisp-coturn.sh` refreshes those copies and
  restarts the container on renewal — without it, TURNS breaks silently in 90 days.

## Coolify application

Resource `wisp-cam`, build pack **Docker Compose**, compose file `/docker-compose.yml`.

Per-service domains (the `:port` suffix is not part of the URL — it tells the proxy
which container port to route to):

| Service | Domain |
|---|---|
| `web` | `https://wisp.best:80` |
| `signaling` | `https://api.wisp.best:8080` |

Environment variables — `VITE_SERVER_URL` **must** be marked a *Build Variable*,
because Vite inlines it into the bundle at build time. `JWT_SECRET` and
`TURN_STATIC_AUTH_SECRET` must **not** be build variables: build args are recorded in
image metadata and readable via `docker history`. Secrets live at
`/root/wisp-secrets.env` on the server.

### Compose constraints this deployment proved the hard way

Each of these caused a failed deploy:

1. **No required-variable syntax (`VAR:?message`).** `docker compose build`
   interpolates the *entire* file including services it isn't building, and Coolify's
   build step only receives build-time variables — so a `:?` on any runtime value
   aborts the build regardless of what is set in the UI.
2. **`build.args` must use list syntax** when `environment` does. Coolify merges args
   into environment; mixing mapping and list forms yields
   `non-string key in services.web.environment`.
3. **Use `expose:`, never `ports:`.** The proxy reaches containers over the internal
   network. Publishing to the host collides with other services on this shared box —
   port 8081 was already taken.
4. **Keep `package-lock.json` in sync.** `npm ci` refuses to run if workspace names
   have changed without regenerating the lockfile.

## Verifying a deployment

```bash
curl https://api.wisp.best/health          # {"ok":true,...}
curl -o /dev/null -w "%{http_code}" https://wisp.best/
```

Then the one check that actually matters — **TURN**. Without a working relay, roughly
one connection in five fails silently. In a browser console on `https://wisp.best`:

```js
const s = await (await fetch('https://api.wisp.best/api/session', {method:'POST',
  headers:{'Content-Type':'application/json'}, body:JSON.stringify({birthDate:'1990-01-01'})})).json();
const ice = await (await fetch('https://api.wisp.best/api/ice',
  {headers:{Authorization:'Bearer '+s.token}})).json();
const pc = new RTCPeerConnection({iceServers: ice.iceServers, iceTransportPolicy:'relay'});
pc.createDataChannel('probe');
pc.onicecandidate = e => e.candidate && console.log(e.candidate.candidate);
await pc.setLocalDescription(await pc.createOffer());
```

**At least one candidate must say `typ relay`.** Nothing at all means TURN is broken,
whatever the logs claim.

## Still outstanding before promoting this publicly

- **Turnstile is not configured** (`TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` are
  empty), so the bot gate is disabled. Create keys at Cloudflare → Turnstile.
- **`ABUSE_CONTACT_EMAIL` is `abuse@wisp.best`** — point it at a mailbox a human reads.
- **Register an NCMEC CyberTipline contact** (free) before real traffic.
- **Nothing reads the reports.** They accumulate in the `wisp-data` volume at
  `/data/reports.jsonl`.
- See the "Known gaps" section of the [README](../README.md), particularly that
  on-device NSFW screening is bypassable and a self-declared age gate is not age
  verification under the UK Online Safety Act.
