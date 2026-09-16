# Mused hosting: Vercel application, GCP assets

The Next.js app runs on Vercel at `https://app.mused.com`. Images, GLBs, splats,
bootstraps and the scene catalog are served directly by Google Cloud Storage/CDN
at `https://static.mused.com/sphr/`. IIIF and a database are not required.

## Domain and bucket assignments

Project: `archimedes-01201`.

| Domain | Bucket | GCP frontend IPv4 |
| --- | --- | --- |
| `static.mused.com` | `mused` | `34.36.73.63` |
| `spaces.mused.com` | `mused-spaces` | `34.110.150.140` |
| `tours.mused.com` | `mused-em` | `34.149.137.219` |

Create explicit A records for these hostnames at the authoritative DNS provider.
Use DNS-only records pointing directly to the GCP load balancers; Google-managed
certificate validation must see those frontend IPs. Remove conflicting records for
these same names. The existing `.org` frontends remain usable.

`app.mused.com` belongs to the Vercel project: add the domain in Vercel and use the
exact DNS record Vercel supplies. Do not point the app hostname at a storage bucket.

The dedicated `mused-sphr` CDN backend uses the `mused` bucket and honors origin
cache headers. The `mused-static` URL map directs `/sphr/*` on the static domains
to that backend; existing asset paths continue using their existing backend policy.
All three buckets' GCS CORS configurations include `https://app.mused.com`. The SPHR CDN backend
allows anonymous cross-origin asset reads; browser config and splat fetches send
credentials only to their own origin.

## Deploy the app to Vercel

Import the `lukehollis/sphr` GitHub repository with the Next.js preset. The repository
root is the application root (do not choose another nested `sphr-next` directory).
Use the standard `npm run build` command. Add `app.mused.com` in project Domains.

When Vercel sets `VERCEL=1`, `next.config.mjs` supplies these public, non-secret defaults:

```text
SPHR_PUBLIC_URL=https://app.mused.com
SPHR_ASSET_BASE_URL=https://static.mused.com/sphr
NEXT_PUBLIC_SPHR_ASSET_BASE_URL=https://static.mused.com/sphr
SPHR_CATALOG_URL=https://static.mused.com/sphr/datasets/matterport/index.json
```

Explicit build environment variables override the defaults for other installations.
Preview deployments use the same public assets. Local development uses local files
unless these variables are set. Changing build configuration requires a redeploy;
publishing a new scene does not.

No GCP credentials belong in Vercel or in browser JavaScript. Vercel reads the public
catalog on each request, and the browser fetches the scene assets from GCP. Large
captures are excluded from Git and from CLI deployment uploads.

The bundled Garden demo also uses bucket assets, including its loading preview.
Optional authored IIIF scenes can use `NEXT_PUBLIC_SPHR_IIIF_BASE_URL` for a separate
image server; the legacy fallback remains `https://iiif.mused.org`. That service is
not used by the imported E57 scenes or the bundled demo. Legacy tour media filenames
resolve against `https://static.mused.com`, configurable with
`NEXT_PUBLIC_SPHR_MEDIA_BASE_URL` for other hosts.

## Import and publish another capture

```sh
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space'
npm run scenes:publish -- --slug my-space --dry-run
npm run scenes:publish -- --slug my-space
```

The publisher needs Python 3.11 or newer and the Google Cloud CLI. Authenticate the
publishing computer with `gcloud auth login` if needed. Publication
defaults to `gs://mused/sphr` and `https://static.mused.com/sphr`. Override `--bucket`,
`--prefix` and `--origin` together when using another host. `--slug` is repeatable.
Omit it to publish all local packages; each must have a successful validation receipt
and current image/mesh hashes. Older incomplete imports need reimporting first.
Use `--include-demo` on initial setup or after changing the Garden demo.

The publisher writes immutable scene revisions:

```text
gs://mused/sphr/
  datasets/matterport/index.json
  scenes/<sceneId>/<content-revision>/
    bootstrap.json
    preview.jpg
    faces/scan-000/face0.jpg ...
    mesh/<storage-slug>-50k.glb
    mesh/atlas.jpg
  demo/...
```

Only the published bootstrap receives absolute CDN URLs; local packages and their
calibration remain unchanged. The publisher checks image and mesh hashes before
upload, uploads the full runtime package, then updates the catalog last. Existing
remote scenes absent from the local machine remain in the catalog. A GCS generation
precondition prevents concurrent publishers from silently overwriting each other;
rerun if another publication wins the race.

Scene revisions use long immutable caching. The catalog uses `Cache-Control: no-store`
and is fetched without a Next.js data cache. Stable `/s/<id>/<title-slug>` links survive
reimports. Old revisions remain available for visitors already viewing them.
Raw E57s, source ZIPs, manifests with local source paths, and validation receipts stay
local; back up those originals and manifests separately.

## Verify

```sh
npm run test:hosting
npm run typecheck
npm run build
curl -I https://static.mused.com/sphr/datasets/matterport/index.json
```

Open the deployed collection and a canonical scene URL. Confirm actual panorama
navigation, dollhouse return, and the Garden guided tour; inspect CORS and loading
errors. A file upload or HTTP 200 alone does not verify a usable scene.
