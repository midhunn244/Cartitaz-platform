# Cartitaz platform

A multi-category dropshipping marketplace with a **private, server-authenticated admin dashboard** and a public storefront
that orders through WhatsApp. No frameworks and no npm dependencies: Node.js 22.13+ and the SQLite built into Node.

```
public/      storefront (what customers see; contains no admin code, links or paths)
admin/       dashboard UI (served only after a valid server-side session)
src/         server: auth, sessions, RBAC, admin API, public API, audit log
scripts/     create-admin, backup, seed-demo
test/        API tests (npm test) and real-browser tests (npm run test:ui)
```

## 1. Run it locally

```bash
node --version            # must be v22.13 or newer
npm run create-admin      # creates the first administrator (there is NO default account)
npm start                 # http://localhost:3000   (storefront)   http://localhost:3000/control-center   (dashboard)
```

## 2. Create the first administrator (securely)

There is no default username or password and no web "setup" page. The first admin can only be created by someone with
shell access to the server:

```bash
npm run create-admin
```

It asks for a username, display name and a password (typed without echo, 12+ characters, common passwords refused).
The first account is the **owner**. Then:

1. Sign in at `/control-center`.
2. **Security → My account → Set up two-factor**: add the key to an authenticator app (Google/Microsoft Authenticator, 1Password, Authy), type the 6-digit code, and **save the 8 one-time recovery codes** that appear (shown only once).
3. **Website settings → General**: enter your real WhatsApp number. Customers cannot send requests until it is set.
4. **Security → Staff**: add managers/support agents. They get a temporary password and must change it at first sign-in.

No shell on your host? See "Render, step by step" below for the `BOOTSTRAP_ADMIN_*` option.

Non-interactive (provisioning scripts): `printf '%s\n' "$PASSWORD" | npm run create-admin -- --username owner --name "Store Owner" --role owner --password-stdin`
Forgot the owner password: on the server run `npm run create-admin -- --reset owner` (signs out all their sessions).

### Two-factor authentication and a lost phone
* Set up entirely inside the dashboard (no shell needed, works on any host). Keep `APP_SECRET` unchanged: it encrypts the 2FA keys, and changing it disables everyone's 2FA.
* Sign in with the 6-digit code, **or** with one recovery code (each works once). Use Security → My account → *Create new recovery codes* when few are left (needs password + current code; old codes stop working).
* Lost phone, have a recovery code: sign in with it, then turn 2FA off and on again with the new phone.
* Lost phone and codes, you are not the only owner: another owner uses Security → Staff → *Reset 2FA*.
* Lost phone and codes, only owner: on the server run `npm run create-admin -- --disable-2fa yourusername` (needs shell/console access to the host), sign in with your password, set 2FA up again.

## 3. Production configuration

Set these as environment variables / secrets on your host (never commit them, never put them in frontend code):

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV=production` | yes | Secure cookies, HSTS, refuses to start with a weak secret |
| `APP_SECRET` | yes | 32+ random characters; encrypts 2FA secrets at rest. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Keep it stable; changing it disables existing 2FA enrolments |
| `DATA_DIR` | yes | Folder on a **persistent disk** holding `cartitaz.db` |
| `TRUST_PROXY=1` | behind a proxy | Set only when exactly one trusted reverse proxy/load balancer sits in front. Without it every visitor looks like the proxy's IP and rate limits misfire. Never set it when the server is directly exposed |
| `ADMIN_PATH` | optional | Admin URL prefix (default `/control-center`). A different path is a convenience only; security does not depend on it |
| `PUBLIC_ORIGIN` | optional | e.g. `https://cartitaz.com`, if your proxy rewrites the Host header |
| `PORT`, `HOST` | optional | Defaults 3000 / 0.0.0.0 |
| `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` | first deploy only | Creates the first owner when the host has no shell. Ignored once any administrator exists. **Delete after first sign-in** |

**HTTPS is mandatory.** Terminate TLS at your host/proxy (Render, Railway, Fly.io, Caddy, Nginx, Cloudflare). In production the session cookie is `Secure`, `HttpOnly`, `SameSite=Strict`.

Open **Security → Security checklist** in the dashboard to see which of these are configured.

### Deploying
This app stores data in a SQLite file, so it needs a **host with a persistent disk and a long-running Node process**
(Render web service + disk, Railway volume, Fly.io volume, a VPS with Docker or systemd). It does **not** run correctly on
Vercel/Netlify serverless functions (no persistent disk). Your current Vercel site is static; move to one of the hosts above.

Docker: `docker build -t cartitaz . && docker run -p 3000:3000 -v cartitaz-data:/data -e APP_SECRET=... -e TRUST_PROXY=1 cartitaz`
Then create the admin inside the container: `docker exec -it <container> node scripts/create-admin.js`.

**Render, step by step**
1. Push the project to a GitHub repository, then Render → New → Web Service → connect it. Runtime: **Docker**.
2. **Choose a paid instance type.** Render's documentation lists Dashboard Shell/SSH as available for *paid web services only*, and free instances have no persistent disk: with the free plan the database is erased on every redeploy/restart and the service sleeps when idle. A real store needs a paid instance plus a **Disk** mounted at `/data`.
3. Environment variables: `NODE_ENV=production`, `APP_SECRET` (long random value), `DATA_DIR=/data`, `TRUST_PROXY=1`.
4. Create the first owner, either way:
   * **With Shell (paid instance):** open the service's **Shell** tab and run `node scripts/create-admin.js`.
   * **Without Shell:** add two *secret* variables, `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` (12+ characters, not containing the username), then deploy. On startup, **only if no administrator exists yet**, the server creates an owner from them. Sign in, you are forced to choose a new password straight away, then **delete both variables** from Render and redeploy. Anyone who can view your Render environment can read that temporary password until you do, which is why it must be changed at first sign-in and the variables removed.

Other hosts work the same way (Railway or Fly.io with a volume, or any VPS with Docker/systemd + Caddy for HTTPS). If you do not want to pay for a managed host, a small VPS is a common choice.

### Backups (required for a real store)
`npm run backup -- /backups/cartitaz-$(date +%F).db` writes a consistent copy while the server runs. Schedule it daily, copy it
off the server, encrypt it (it contains customer addresses and phone numbers), and test a restore (stop the server, replace
`DATA_DIR/cartitaz.db`, delete `cartitaz.db-wal`/`-shm`, start).

## 4. What is enforced on the server

* **Authentication**: scrypt (N=32768) salted password hashes; random 256-bit session tokens, only a SHA-256 hash is stored; sessions expire after 30 min idle / 12 h absolute; new session at every login; all sessions revoked on password change, 2FA change, disable or role change.
* **Brute force**: 5 failures lock an account for 15 min; 15 sign-in attempts per IP per 15 min; same error for unknown users and wrong passwords; a dummy hash is verified for unknown users to equalise timing.
* **Two-factor** (TOTP, RFC 6238) with replay protection; secrets encrypted with AES-256-GCM.
* **Every admin page, asset and API route** checks the session on the server. Unauthenticated requests get the login page or 401/404; the dashboard script is not even downloadable without a session. `npm test` calls every protected route anonymously.
* **CSRF**: SameSite=Strict cookie + per-session token header + Origin check on every state-changing request.
* **Authorization (RBAC)**, checked server-side per route:

| | Owner | Manager | Support |
|---|---|---|---|
| Products, categories, inventory, promotions, suppliers, website settings | all | all | read products/categories/inventory |
| Orders & WhatsApp requests | all | all | view + move status, notes (no costs) |
| Customers (personal data) | all | all | read |
| Supplier costs, profit, expenses, refunds | yes | yes | **never sent** |
| Staff accounts, audit log, sessions of others | yes | no | no |

* **Private data never reaches the public API**: supplier, purchase price, internal notes and exact stock levels are excluded from `/api/public/*` (tested). Images of unpublished products are not served publicly.
* **Audit log** (append-only; no delete route): sign-ins and failures, permission denials, product price/cost changes with before/after, status changes, refunds, stock adjustments, settings, user changes, 2FA changes. Passwords/hashes are never logged.
* **Validation** of every input (types, ranges, enums, image magic bytes, size limits); all SQL is parameterised; the dashboard builds its UI with `textContent` only and runs under a CSP with **no inline scripts or styles**.
* **WhatsApp requests are never auto-confirmed.** A customer's request is stored as `new_request`. Opening WhatsApp changes nothing. Stock is deducted, promo codes are counted and revenue is recognised only when a staff member moves the order to *Confirmed*. Status moves follow an allowed-transition table.
* **Sales and profit** use recorded data only: confirmed orders; revenue − recorded supplier cost − order expenses − refunds − general expenses. Orders where any item has no recorded supplier cost are shown as *incomplete* and excluded from profit (they still count in sales).

## 5. Needs extra configuration or infrastructure (not included)

* **TLS/HTTPS, domain, persistent disk, backups, monitoring/alerts**: provided by your host, you must set them up.
* **Multiple server instances**: rate limiting and lockout counters for the login are partly in memory. Run **one** instance, or move the limiter to Redis before scaling out.
* **WhatsApp Business API** (automatic sending, delivery receipts, webhooks): not included. The dashboard opens `wa.me` chats that a human sends. Without the API the system cannot know whether a message was sent or read.
* **Payments**: none. Payment is arranged manually on WhatsApp and recorded by staff.
* **Email/SMS password reset**: none. Owners reset staff passwords in the dashboard; a locked-out owner uses the CLI.
* **QR codes for 2FA**: the key is shown as text for manual entry in the authenticator app.
* **Image storage at scale**: images live in the database (re-encode and limit to 1.5 MB, 8 per product). For thousands of products use object storage/CDN.
* **Customer reviews, ratings and customer photos** on the storefront are stored in each visitor's own browser, not on the server. Making them shared and moderated needs additional server work.
* **Courier integration / automatic tracking numbers**: tracking is entered by staff (status and country/state/district).
* **Independent security review**: this code has automated tests (below) but has **not** been penetration-tested. Have it reviewed before handling real customer data at scale.
* The old in-page "owner" admin from the earlier single-file prototype is **not secure by this standard**. Do not use it; this platform replaces it.

Known trade-offs: a locked account reveals that the username exists; an attacker can temporarily lock an account by guessing (owners can unlock, per-IP limits apply); the storefront is a single HTML file so its CSP allows inline scripts (the dashboard's does not).

## 6. Tests

```bash
npm test            # ~280 API/security checks against a temporary database (no browser needed)
npm run test:ui     # drives the real dashboard and storefront in headless Chromium (needs: pip install playwright && playwright install chromium)
```
