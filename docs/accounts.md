# Customer accounts, billing and hosted processing

SPHR can optionally let people create their own accounts, pay per hosted space, upload
capture data and have it processed into a space by a coding agent. Everything here is off
unless configured; a self-hosted installation without these settings behaves exactly as
described in [hosting](hosting.md).

The flow for a customer:

1. Sign up with Google, Apple, LinkedIn, or an email address and password (`/account/signup`).
   Email accounts confirm their address before adding spaces.
2. Add a space. *Add a space* (or files dragged anywhere onto *Your spaces*) opens a
   full-screen sheet that takes files or whole folders. The space is created at once, titled
   from the file or folder names (the customer can change the title then or later). The
   first space starts hosting: the sheet shows the ways to pay with pay as you go chosen
   (a price per space each month) beside any plans that cover a set number of spaces for one
   price, payment opens in a new tab for the chosen one, and the dropped files start
   uploading in the first tab as soon as it goes through. On pay as you go, later spaces
   join the same subscription, prorated on the next invoice. On a plan, spaces are added
   until the plan is full; the sheet then keeps the files while the customer moves to a
   plan with room. Prices appear in the sheet, on the plan page (`/account/plan`) and, for
   subscribers, above their spaces. Sign-in, sign-up and an account without spaces leave
   them out, because many visitors sign in only to open a space. When `SPHR_SOURCE_URL`
   is set, the plan choice notes that the service is open source and links to its code.
3. Capture files of any kind upload from the sheet: Matterport or other E57 exports, Gaussian
   splats, 360 photos or video, ordinary video, lidar point clouds, scanned meshes. Browsers
   upload directly to a private Cloud Storage bucket in resumable 8 MiB chunks, so interrupted
   multi-gigabyte uploads resume. Uploads keep going after the sheet is closed while the page
   stays open, and each space's card shows its progress.
4. Processing starts on its own 10 seconds after an upload finishes (the customer can start it
   at once or wait to add more files, and leaving the page during those seconds starts it at once).
   Files added later to a hosted space wait until the customer reprocesses it. A waiting agent
   runner picks the job up within seconds, and the cards and the space page show the agent's
   latest step as it works. The customer is emailed when processing starts, when the space is
   published (with its preview image) and when it cannot be finished, and can then preview
   it, make it public, and edit its title, start view and thumbnail. If the upload cannot
   become a space, the page says what to upload instead.

Account emails (address confirmation, password resets, sign-in changes and the processing
notices above) are sent as HTML with a plain-text alternative, laid out after the 1975 NASA
Graphics Standards Manual. The templates are in `lib/server/emails.ts`.

Customer spaces are listed from the application database, never from the shared
`index.json` catalog, so they do not appear in any public listing. *Private* means the
viewer page requires the owner's (or the operator's) sign-in. The published asset files
are served from unguessable URLs, so they are private only if the asset bucket does not
allow anonymous object listing; see [upload and asset storage](#upload-storage).

On pay as you go, the subscription quantity always equals the customer's spaces that are
not deleted. Deleting a space lowers it (credited on the next invoice). A plan is one unit
whatever the number of spaces, and a customer cannot add more spaces than it covers. Plans
change on the plan page: the subscription item moves to the new price at once, and the
difference is prorated onto the next regular invoice. A plan must cover every space the
customer has. If a subscription ends or stays unpaid, the customer's spaces go offline
until billing restarts; `past_due` subscriptions stay online while Stripe retries the payment. The operator's `/admin`
login is separate and continues to see and manage every space.

## Publishing from a customer's own agent

A customer can let their own agent (Claude, Codex, Grok Build, Antigravity and others that run MCP
servers) publish captures for them. Two connectors share the same account routes, limits and billing:

- **The local connector** (`connector/`) is a dependency-free MCP server that runs on the customer's
  computer, so it can read multi-gigabyte captures from disk. It uploads in the background, in the
  same resumable chunks as the browser, keeps going if the chat ends and submits the space when the
  upload finishes. `node connector/build.mjs` packages it for one site: a Claude Desktop extension
  (`.mcpb`), a versioned tarball for `npx -y <url>`, a skill and a setup page for agents. The site's
  name and addresses are stamped in at build time, so none are committed.
- **The hosted endpoint** (`/mcp`, Streamable HTTP) serves agents that run in the cloud and take a
  connector URL (Meta Muse, claude.ai, ChatGPT). It cannot read the customer's disk: it uploads files
  the agent holds itself and otherwise sends the customer to the space's page to drop files. Set
  `SPHR_AGENT_CONNECTOR_URL` to the setup page to have it mention the local connector.

Agents link the way a TV signs in. The agent asks `/api/agent/link` for a code and opens
`/account/connect/<code>` in the customer's browser, where they sign in and approve it; the agent
then collects a bearer token from `/api/agent/token`. Tokens (`sphr_…`, stored hashed) can add and
read spaces, upload, submit, change visibility and start Checkout. Deleting spaces, the billing
portal, plan changes, account settings and approving other agents stay with the browser session.
Tokens are listed under *Linked agents* on *Your spaces*, where the customer can unlink them, and are
revoked with the customer's sessions on a password reset. Payment always happens in Stripe
Checkout in the customer's browser; the agent never handles card details. Checkout started by an
agent returns to a page that tells the customer to go back to it. A hosted session keeps its link
code and token sealed with a key derived from the session ID, which only the agent holds.

`node scripts/test-agent-connector.mjs` drives both connectors end to end against a development
server with local stand-ins for Stripe, Google and email.

## Operator notifications

With `SPHR_DISCORD_WEBHOOK_URL` set to a Discord channel webhook, the operator hears about new
accounts, spaces created, spaces submitted for processing (from the website or an agent), spaces
that are ready or need attention, deleted spaces, linked agents, and billing changes: a new
subscription, a plan change, a failed payment, a scheduled or withdrawn cancellation, and hosting
stopping. Billing notices compare the saved subscription with Stripe's latest state in one
transaction, so repeated webhooks and returns from Checkout announce each change once. Delivery is
best effort, queued one message at a time and retried when Discord asks to slow down; a failure is
logged and never affects the customer. Notices never mention anyone, whatever a title says.

## Runtime settings

Accounts build on access control. Add these to the runtime environment
(`/etc/sphr/environment` on the Debian deployment), never to Git:

```dotenv
SPHR_ACCESS_CONTROL=1
SPHR_STATE_DIR=/var/lib/sphr
SPHR_ACCOUNTS=1
SPHR_PUBLIC_URL=https://app.example.com

# Email: verification, password resets and "your space is ready" notices.
# Without it, email sign-up is hidden and only the providers below are offered.
SPHR_SMTP_URL=smtps://user:password@smtp.example.com:465
SPHR_MAIL_FROM="Example Spaces <no-reply@example.com>"

# Sign-in providers. Each appears only when fully configured.
SPHR_GOOGLE_CLIENT_ID=...
SPHR_GOOGLE_CLIENT_SECRET=...
SPHR_APPLE_CLIENT_ID=com.example.web          # the Services ID
SPHR_APPLE_TEAM_ID=...
SPHR_APPLE_KEY_ID=...
SPHR_APPLE_PRIVATE_KEY_FILE=/etc/sphr/apple-signin.p8
SPHR_LINKEDIN_CLIENT_ID=...
SPHR_LINKEDIN_CLIENT_SECRET=...

# Billing. Without these, customer spaces are free.
SPHR_STRIPE_SECRET_KEY=sk_live_...
SPHR_STRIPE_PRICE_ID=price_...                # pay as you go, per space
SPHR_STRIPE_PLAN_PRICES=price_...,price_...   # optional plans covering a set number of spaces
SPHR_STRIPE_WEBHOOK_SECRET=whsec_...
# SPHR_STRIPE_AUTOMATIC_TAX=1                 # after enabling Stripe Tax

# Uploads. Without a bucket, files are kept under SPHR_STATE_DIR/uploads.
SPHR_UPLOAD_BUCKET=example-customer-uploads
SPHR_UPLOAD_MAX_GB=50                         # per space
# GOOGLE_APPLICATION_CREDENTIALS=/etc/sphr/uploads-service-account.json

# Processing workers authenticate with this token (32+ random characters).
SPHR_WORKER_TOKEN=...

# Published customer spaces: their public, non-listable asset host, and the bucket the
# application may delete from when a customer deletes a space.
SPHR_CUSTOMER_ASSET_BASE_URL=https://storage.googleapis.com/example-customer-assets/sphr
SPHR_CUSTOMER_ASSET_BUCKET=example-customer-assets
# SPHR_CUSTOMER_ASSET_PREFIX=sphr

# Privacy and terms pages (/privacy, /terms), linked from sign-in. Review their wording.
SPHR_OPERATOR_NAME="Example Spaces"
SPHR_CONTACT_EMAIL=support@example.com
# Where the code this deployment runs is published. The plan choice links to it.
# SPHR_SOURCE_URL=https://github.com/example/sphr
```

Restart the service after changing these. Accounts, sessions, subscriptions, spaces,
uploads and jobs are stored in `SPHR_STATE_DIR/admin.sqlite` with the existing admin
data; back it up as described in [hosting](hosting.md#admin-and-website-visibility).

### Client addresses behind a proxy

Sign-in and sign-up limits are counted per client address from `X-Real-IP`, which the
example Nginx configuration sets to the connecting address. **Behind Cloudflare that is a
Cloudflare edge**, so visitors routed through the same edge share one limit and can lock
each other out of signing in. Before enabling accounts behind Cloudflare, restore the
visitor address in Nginx with `real_ip_header CF-Connecting-IP;` and a `set_real_ip_from`
line for each of Cloudflare's published ranges, and accept origin traffic only from
Cloudflare. The same applies to the existing admin sign-in limit. Password sign-in for one
address is also limited to 20 attempts per 15 minutes; provider sign-in and password
resets are unaffected by that limit.

## Sign-in providers

Register each provider with the redirect URL shown. The URLs must use the public origin.

- **Google** (Google Cloud console → APIs & Services → Credentials → OAuth client ID,
  type *Web application*). Authorized redirect URI:
  `https://app.example.com/api/auth/google/callback`. The consent screen needs the
  `openid`, `email` and `profile` scopes. Google sign-in uses PKCE and a nonce.
- **Apple** (Apple Developer → Certificates, Identifiers & Profiles). Create a *Services ID*
  (this is `SPHR_APPLE_CLIENT_ID`) with Sign in with Apple enabled, the app's domain, and
  return URL `https://app.example.com/api/auth/apple/callback`. Create a key with Sign in
  with Apple enabled; its `.p8` file is the private key, and its key ID and your team ID
  complete the settings. Apple returns with a cross-site form POST, which is why its
  short-lived state cookie is `SameSite=None; Secure`. It shares the person's name only
  on the first sign-in, and may share a private relay email address.
- **LinkedIn** (LinkedIn Developer portal → your app). Add the product *Sign In with
  LinkedIn using OpenID Connect*, then add the redirect URL
  `https://app.example.com/api/auth/linkedin/callback` under Auth.

Every ID token's signature, issuer, audience, lifetime and nonce are verified against the
provider's published keys. A provider sign-in joins an existing account only when the
provider reports the email address as verified. If that account has a password, the
password and every session are removed and the owner is emailed: someone else may have
registered the address, and the provider has now proven who owns it. The owner can set a
new password with *Forgot password?*. Email confirmation links open a page with a
*Confirm* button, so mail scanners that prefetch links confirm nothing.

## Stripe

1. Create a product (for example "Pay as you go") with a **recurring, per-unit price**
   (standard pricing, licensed usage, monthly or yearly). Put its ID in `SPHR_STRIPE_PRICE_ID`.
   The app reads the amount from Stripe, so changing the price needs no rebuild;
   create a new price and update the setting.
   Plans are optional: one product per plan (for example "Starter") with a recurring price
   whose metadata `sphr_spaces` is the number of spaces it covers. List their price IDs,
   comma-separated, in `SPHR_STRIPE_PLAN_PRICES`. Plans show under their product names,
   from the smallest, after pay as you go. Give every price the same currency and interval.
   With Stripe Managed Payments, each product needs an eligible tax code such as
   `txcd_10701100` (Website Hosting). `scripts/deploy/stripe-setup.mjs` creates all of this,
   by default pay as you go at 2 USD a space and Starter (8 USD, 6 spaces), Pro (50 USD,
   30 spaces) and Enterprise (249 USD, 200 spaces) a month; change them with `--amount`
   and `--plans name:cents:spaces,...`.
2. Add a webhook endpoint `https://app.example.com/api/stripe/webhook` for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused` and
   `customer.subscription.resumed`. Its signing secret is `SPHR_STRIPE_WEBHOOK_SECRET`.
3. Configure the Customer Portal: allow payment method updates, invoice history and
   cancellation at the end of the billing period. **Do not allow quantity or plan changes**;
   the quantity follows the number of spaces (or is one for a plan) and is reset if changed
   elsewhere, and plan changes happen in the application, which checks that a plan covers
   every space.

When you change a price, existing subscriptions keep the price they started with, and
new subscriptions use the new one. A plan price keeps its space limit in its metadata, so
customers on a retired plan price keep its limit. Move existing customers to a new price in
Stripe if needed. Plan changes and added spaces are never invoiced on their own, because
Managed Payments does not allow invoices outside the billing period.

Stripe's fixed fee applies per invoice, not per space: all of a customer's spaces share
one subscription and one invoice per period. Proration for spaces added or deleted mid-period
is collected on the next regular invoice rather than charged separately.

For local testing, use test-mode keys and forward events with
`stripe listen --forward-to localhost:3002/api/stripe/webhook`.

## Upload storage

Create a **private** Cloud Storage bucket for uploads, separate from the public asset
bucket, with uniform bucket-level access and public access prevention. The application
starts each resumable upload session itself, with the viewer origin, so Cloud Storage
answers the browser's chunk uploads with CORS headers; the bucket needs no CORS
configuration. Upload session URLs are never shared with anyone but the uploading customer.

The application's service account needs `roles/storage.objectAdmin` on this bucket. On
Compute Engine the application uses the VM's service account, whose access scopes must
include read/write Cloud Storage; otherwise set `GOOGLE_APPLICATION_CREDENTIALS` to a key
file readable only by the `sphr` user. Deleting a space deletes its uploads; add a
lifecycle rule (for example, delete `uploads/` objects older than 90 days) so raw captures
do not accumulate after processing.

Without `SPHR_UPLOAD_BUCKET`, chunks pass through the application to
`SPHR_STATE_DIR/uploads`. Allow 8 MiB request bodies in the proxy (`client_max_body_size 9m`
in the example Nginx configuration).

**Published customer spaces** need an asset bucket that serves objects publicly but does
not let anyone list them. Grant `allUsers` a role with `storage.objects.get` only (for
example `roles/storage.legacyObjectReader`), not `roles/storage.objectViewer`, which
also allows listing. Check with
`curl "https://storage.googleapis.com/<bucket>?prefix=<prefix>/scenes/"`: it must return
403. If your existing asset bucket allows listing, publish customer spaces to a separate
bucket (with the same CORS settings as the asset bucket) and set its public prefix in the
application:

```dotenv
SPHR_CUSTOMER_ASSET_BASE_URL=https://customer-assets.example.com/sphr
```

## Processing skills and tools

The processing agent starts from `.agents/skills/sphr-intake/SKILL.md`, which inspects the
uploads (`scripts/packages/inspect-inputs.mjs`) and routes each kind of capture:

| Capture | Skill | Result |
|---|---|---|
| Matterport or other E57 with registered panoramas | `sphr-matterport` | Calibrated panoramas, mesh and dollhouse |
| Gaussian splat (PLY, SPZ, SPLAT, KSPLAT, SOG) | `sphr-splat-package` | Splat space opening in orbit (`build-splat.mjs`) |
| 360 photos; 360 video | `sphr-panorama-package` | Guided panorama tour (`build-panoramas.mjs`, `build-video360.mjs`) |
| Ordinary video or photo sets | `sphr-video` | COLMAP poses and a trained splat, or held for an operator without a GPU trainer |
| Lidar point clouds (LAS/LAZ, E57 without images, PLY, PCD, XYZ) | `sphr-lidar-package` | Point-cloud splat (`build-pointcloud.mjs`) |
| Scanned meshes (OBJ, GLB, PLY, STL, USDZ, FBX) | `sphr-lidar-package` | Orbitable model (`build-model.mjs`) |

Every tool writes a `sphr-package-v1` package: `bootstrap.json`, `preview.jpg`, the runtime
files, and `manifest.json` listing each file with its SHA-256. `validate-package.mjs` checks
that every file is listed, typed and inside the package and that every URL in the bootstrap
points at one of those files. The agent looks at each `preview.jpg` to confirm orientation.

## Processing with an agent

Submitted spaces wait in a queue. `scripts/worker/agent-runner.mjs` works through it:
it claims a job, downloads its files, runs a coding agent in the job's directory,
validates the package the agent built, publishes it, and marks the space ready. The
agent is told which scene ID and storage slug to use; the server reserved that ID for
the space when it was submitted, and completing a job requires that ID to be live in the
catalog. Reprocessing a ready space keeps its ID, so links keep working.

The runner needs the worker token, publishing settings for the customer asset bucket,
an authenticated `gcloud` able to read the upload bucket and write that asset bucket, and
the importer's Python environment. It publishes assets with
`publish.py --no-catalog` and hands the listing to the application; it never changes the
shared catalog. Run it from a checkout of this repository:

```sh
export SPHR_WORKER_URL=https://app.example.com
export SPHR_WORKER_TOKEN=...                    # same value as the application
export SPHR_PUBLISH_BUCKET=your-customer-assets-bucket
export SPHR_PUBLISH_ORIGIN=https://customer-assets.example.com
# export SPHR_PUBLISH_PREFIX=sphr               # default; must match SPHR_CUSTOMER_ASSET_BASE_URL
export SPHR_PUBLIC_URL=https://app.example.com
export SPHR_AGENT_ISOLATION=container           # container, user or vm; see below
export SPHR_AGENT_COMMAND='["docker","run","--rm","-e","CLAUDE_CODE_OAUTH_TOKEN","-e","SPHR_JOB_DIR","-e","SPHR_SCENE_ID","-e","SPHR_SCENE_SLUG","-v","/path/to/sphr-next/scripts:/opt/sphr/scripts:ro","-v","/path/to/sphr-next/.agents:/opt/sphr/.agents:ro","-v","{job}:{job}","-w","{job}","sphr-agent","claude","-p","{prompt}","--model","sonnet","--dangerously-skip-permissions"]'
export SPHR_AGENT_REPO=/opt/sphr                # where the agent sees the scripts and skills
export SPHR_AGENT_ENV=CLAUDE_CODE_OAUTH_TOKEN   # or ANTHROPIC_API_KEY
export SPHR_WORKER_CONCURRENCY=1
docker build -f scripts/worker/agent.Dockerfile -t sphr-agent .
node scripts/worker/agent-runner.mjs list
node scripts/worker/agent-runner.mjs run        # waits for jobs; add --once for one job
```

`{prompt}` is replaced with the job instructions (they are also saved as `PROMPT.md` in
the job directory) and `{job}` with the job directory. `scripts/worker/agent.Dockerfile` builds
the sandbox: the Claude CLI, Python with the E57, lidar and mesh libraries, ffmpeg, COLMAP and
Blender, running as a non-root user. The repository's scripts and skills are mounted read-only;
only the job directory is writable. The agent appends one line per step to
`output/progress.log`, and the runner forwards the newest line to the customer's page. Job directories default to
`local/worker-jobs/<job>` and keep `agent.log`, the inputs and the output for review.

**Uploaded files are untrusted, and so is the agent that reads them.** The prompt tells the
agent to treat uploads as data, but a crafted file can still steer it, and an agent with a
shell can do anything its operating-system account can. Environment scrubbing alone does
not stop that: the runner's gcloud configuration, its process environment and, on Compute
Engine, the metadata server's VM credentials are all reachable from the same account. So:

- The runner refuses to process jobs until `SPHR_AGENT_ISOLATION` is `container`, `user` or
  `vm`, your statement that the agent command runs **without** access to this runner's
  files, processes and cloud credentials. Use a container or VM whose only secret is the
  model API key, with the repository mounted read-only, the job directory mounted
  read-write, and network access limited to the model API (block `169.254.169.254` and
  `metadata.google.internal`). For example:
  `["docker","run","--rm","--network=agent-egress","-e","ANTHROPIC_API_KEY","-v","{job}:{job}","-v","/srv/sphr-next:/srv/sphr-next:ro","-w","{job}","sphr-agent","claude","-p","{prompt}","--permission-mode","acceptEdits"]`.
- Only `PATH`, locale variables and the names in `SPHR_AGENT_ENV` reach the agent. Worker,
  Stripe, publishing and cloud credential variables are always removed. Its `HOME` is a
  fresh directory in the job folder unless `SPHR_AGENT_HOME` is set.
- The agent never publishes. The runner copies `catalog.py` and `publish.py` when it starts,
  checks their hashes before each use and runs them with `python3 -I`. It accepts a
  package only if it uses the reserved scene ID, slug and the customer's title, points
  only at its own folder and passed validation, and then publishes only the runtime files
  the manifest lists (no symlinks, no extra files).

The importer handles Matterport E57 exports today. For other inputs (Gaussian splats,
360 photos, video, other scanners) or anything the agent cannot verify, it writes
`needs_operator`, the runner puts the job on hold, and the customer sees *Processing*
until a person finishes it. A job whose worker stops responding returns to the queue after
`SPHR_JOB_LEASE_HOURS` (12 by default; keep it above `SPHR_AGENT_TIMEOUT_MINUTES`) and is
held after three attempts. Finish a held job by building its package in
`local/worker-jobs/<job>/output/public/datasets/matterport/<slug>/`, then:

```sh
node scripts/worker/agent-runner.mjs publish <job> "Message for the customer"
node scripts/worker/agent-runner.mjs fail <job> "What to upload instead"
node scripts/worker/agent-runner.mjs release <job>          # back to the queue
```

A failed job shows its message to the customer, who can add or replace files and submit
again (at most 5 submissions per space and 20 per account each day, since each one runs an
agent). Deleting a space, even mid-processing, cancels its job and takes it offline
immediately; its published assets stay in the asset bucket under `scenes/<sceneId>/` until
you remove them.

Self-hosted installations that serve packages from their own `public/datasets` directory
can set `SPHR_WORKER_PUBLISH=local` (and optionally `SPHR_WORKER_LOCAL_DATASETS`) to
install packages there instead of publishing to Cloud Storage. Restart `next start` so it
serves the new files.

## Worker API

All requests carry `Authorization: Bearer $SPHR_WORKER_TOKEN`.

- `GET /api/worker/jobs?status=queued,running` lists jobs with their reserved `sceneId`,
  storage `slug`, title, customer notes and uploads (`gs://` URIs, or a download URL
  under `/api/worker/uploads/<id>` for local storage).
- `GET /api/worker/jobs?status=queued&wait=45` waits up to 45 seconds for a job to be queued.
- `POST /api/worker/jobs/<id>` with `{"action":"claim","worker":"name"}`,
  `{"action":"release"}`, `{"action":"progress","message":"…"}` (shown to the customer),
  `{"action":"hold","message":"…"}` (for an operator),
  `{"action":"complete","message":"…","scene":{…}}` (the published catalog entry from
  `publish.py --entries-out`, checked against the reserved scene ID, slug and asset host)
  or `{"action":"fail","message":"…"}` (shown to the customer).

## Verification

```sh
npm run test:accounts
npm run test:accounts-routes
npm run typecheck
npm run build
```

`test:accounts` covers passwords, sessions, single-use links, account linking, ID token
verification, the queue and billing (pay as you go, plans and plan changes) against a local
stand-in for the Stripe API. `test:accounts-routes` starts a development server with local
stand-ins for Stripe, the three identity providers and an SMTP server, then exercises
sign-up, verification, every sign-in method, Checkout on each plan and webhooks, full plans
and plan changes, pausing and resuming hosting, resumable
uploads, customer isolation, private viewing and editing, and the agent runner. Run it
in a checkout without local capture packages, because it installs a test package into
`public/datasets` and removes it afterwards. Test live providers and Stripe test mode on
a staging origin before enabling production keys.
