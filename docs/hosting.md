# Self-hosting SPHR

SPHR is a generic Next.js viewer and migration pipeline. A clean checkout reads
local scene catalogs and assets. No production collection, image host, cloud bucket,
account or operator branding is configured by default. Generated capture packages,
source exports, credentials, deployment profiles and per-capture reviews stay out
of Git. Keep deployment settings in ignored local environment files or on the host.

## Application and static assets

Run the Next.js app on a Node 24 host, with HTTPS in front of it. Store generated
images, GLBs, splats and bootstraps on persistent local storage or a static asset
host such as Google Cloud Storage with a CDN. E57 imports contain ready-to-serve
JPEG faces and GLBs; they do not require an IIIF server.

For local assets, keep `public/datasets` available across application releases.
For a remote asset host, configure these public build settings with your domains:

```dotenv
SPHR_PUBLIC_URL=https://app.example.com
SPHR_ASSET_BASE_URL=https://static.example.com/sphr
NEXT_PUBLIC_SPHR_ASSET_BASE_URL=https://static.example.com/sphr
SPHR_CATALOG_URL=https://static.example.com/sphr/datasets/matterport/index.json
```

Use `.env.production.local` for a manually built deployment. Values exposed to
the browser are compiled at build time; rebuild after changing them. The catalog
is fetched without caching, so adding a completed scene does not require rebuilding
the application. Set the public URL to the actual viewer origin for metadata and
admin origin validation.

```sh
npm ci
npm run typecheck
npm run build
npm run start
```

Configure the asset host to permit `GET`, `HEAD` and `OPTIONS` from your viewer
origin (or `*` for public assets). Preserve byte-range requests for GLB and video.
Versioned scene assets use immutable caching; the catalog uses `no-store`.

## Publishing verified captures to GCS

The publisher requires an explicit destination. It never selects an operator's
bucket automatically. Configure the following in your shell, or use the matching
`--bucket`, `--origin` and `--app-origin` arguments:

```sh
export SPHR_PUBLISH_BUCKET=your-assets-bucket
export SPHR_PUBLISH_ORIGIN=https://static.example.com
export SPHR_PUBLIC_URL=https://app.example.com
npm run scenes:publish -- --slug my-space --dry-run
npm run scenes:publish -- --slug my-space
```

The default path prefix is `sphr`; override it with `--prefix`. The publisher checks
the validated manifest and current asset hashes, uploads immutable runtime assets,
then merges `datasets/matterport/index.json` with a generation guard. It preserves
other entries and old revisions. Source exports, local manifests and reports are
not uploaded. `--include-demo` also uploads the available bundled demo assets.

To make a selected capture publicly viewable after publication, supply
`SPHR_PUBLISH_ADMIN_USERNAME` and `SPHR_PUBLISH_ADMIN_PASSWORD` through a secret
environment and append `--make-public`. This requires an explicit `--slug` and
changes only those selected scene IDs. Never put credentials in command arguments,
examples or committed files. Verify the anonymous canonical URL in a real browser.

## Admin and website visibility

Enable optional access control with runtime settings:

```dotenv
SPHR_ACCESS_CONTROL=1
SPHR_STATE_DIR=/var/lib/sphr
```

New scene IDs are private when access control is enabled. `/admin` supports preview,
Public/Private settings, password changes and logout. The collection footer then
shows a local Login link; there is no external account service or default signup.
Without access control, the collection has no footer and lists all catalog entries.

Initialize the single admin account with `scripts/deploy/admin-init.mjs`, Node 24,
and `SPHR_STATE_DIR` set. Provide a JSON object with `username` and `password` through
stdin. It refuses to overwrite an existing account. Keep `/var/lib/sphr` private
and persistent across deploys: it contains password hashes, sessions and visibility.
Use SQLite's online backup API or stop the service before copying the state directory.

Visibility controls access to the website viewer. Assets already hosted in a public
bucket remain directly accessible; a private viewer setting does not make those
files private. Restrict asset delivery separately if your installation requires it.

### Editing spaces

Sign in at `/admin`, choose **Edit space**, and navigate in the live viewer. Use
**Use current view** to select the opening panorama, direction and zoom together
with a clean 960 × 640 thumbnail. Review the thumbnail, then **Save changes**.
The zoom buttons also work on mobile. You can edit the title independently or
restore the imported start view and thumbnail. The permanent ID remains stable;
old title URLs redirect to the current title.

Edits and thumbnail bytes are saved atomically in `SPHR_STATE_DIR/admin.sqlite`,
separate from the immutable capture packages. Back up this database along with
your account and visibility data. Catalog updates, reimports and releases retain
edits. If a reimport removes a selected scan ID, the viewer falls back to the new
package's default start. Concurrent saves from an older editor are rejected.
Thumbnail delivery follows the scene's viewer visibility.

For an authored native tour, this changes the first stop's camera while retaining
its story, audio and subsequent stops. The editor stays in the opening space.
Embedded Matterport viewers and tours that open on standalone model stops retain
their existing camera configuration; their titles remain editable. Import the
Matterport capture to enable native start-view and thumbnail editing.

## Debian VM deployment

`scripts/deploy/vm-release.sh` builds isolated releases for a Debian x86_64 host,
installs the generic `sphr` systemd service, checks health and rolls back a failed
startup. It preserves `/var/lib/sphr` and shares only the runtime cache between releases.

Place public build settings from above in `/etc/sphr/build.env`, readable by the
deploying user. `SPHR_BUILD_ENV` may select another file. The script requires the
application and asset origins because its releases exclude local capture data.
Place runtime access-control settings in `/etc/sphr/environment`, loaded by systemd.
Keep both files outside the checkout. Then run from a clean committed checkout:

```sh
bash scripts/deploy/vm-release.sh
```

The service listens on `127.0.0.1:3035`. Copy and adapt
`scripts/deploy/app.nginx.example` for your hostname and certificate paths. Obtain
the HTTPS certificate before enabling its TLS server. Point DNS at the application
host, run `nginx -t`, then reload Nginx. The optional `sphr-reload-nginx.sh` Certbot
hook validates and reloads Nginx after renewal. Domain redirect rules belong to the
deployment's DNS/proxy configuration, not the viewer code.

## Optional Google Analytics

To send collection and viewer traffic to your own GA4 property, add its web-stream
measurement ID to the build environment and rebuild:

```dotenv
NEXT_PUBLIC_SPHR_GOOGLE_ANALYTICS_ID=G-YOURMEASUREMENTID
```

Analytics is disabled when this setting is absent or invalid. The tag loads after
the interface becomes interactive and is omitted on admin and login pages. Keep
the real property ID in the deployment environment, outside Git. The standard
Google tag sends the initial page view; enable history-based page views in the
GA4 stream's Enhanced Measurement settings for client-side navigation. Do not add
a second manual page-view handler alongside automatic history tracking.

## Optional IIIF and legacy media

For older image-server scenes, configure public build settings:

```dotenv
NEXT_PUBLIC_SPHR_IIIF_BASE_URL=https://iiif.example.com
NEXT_PUBLIC_SPHR_MEDIA_BASE_URL=https://static.example.com
```

Without these settings, static media is same-origin and IIIF identifiers use the
same-origin `/iiif` prefix. SPHR does not implement the image server itself: reverse
proxy that prefix to your image server or configure its HTTPS origin. Explicit
absolute image and video URLs remain unchanged.

Optional Loris deployment examples are `scripts/deploy/iiif-loris.service`,
`iiif-loris.wsgi`, `iiif.nginx.example` and `iiif-reload-nginx.sh`. Install Loris
separately, create its service user, configure the source-image resolver and cache,
and adapt paths and hostnames before installing these examples. Preserve encoded
slashes in IIIF identifiers and CORS headers on errors and redirects. A legacy
hostname requires a valid certificate before redirecting HTTPS traffic.

For migrating older native SPHR collections and authored tours, see
[legacy recovery](legacy-recovery.md). For external-drive workflows, see
[local capture storage](local-capture-storage.md).

## Verification

Run `npm run test:hosting`, `npm run test:admin`, `npm run typecheck` and
`npm run build`. Inspect desktop and mobile collection layouts, actual panorama
navigation, dollhouse entry, authored tours and a private viewer after login.
Test admin route mutations only on a disposable local state database with the
local catalog or an explicit `SPHR_TEST_CATALOG_URL`.
