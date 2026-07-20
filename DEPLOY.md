# Deploying the Heat Tracker to Cloudflare Pages

The site is a standalone Hugo build in this repo (`hugo` → `public/`). These are the
one-time steps to stand up the Cloudflare Pages project and the `heat.marybecica.com`
subdomain. They need your Cloudflare account, so they can't be automated from here — do them
in the dashboard when you're ready. Nothing below blocks local development (`hugo server`).

## Prerequisites

- The repo is pushed to GitHub as `mbecica/ca-carceral-heat-tracker` (already the case).
- Cloudflare account with `marybecica.com` on Cloudflare DNS (same account that hosts the
  personal site — the tracker's builds draw on the shared 500 builds/month quota, with headroom).

## 1. Create the Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick the `ca-carceral-heat-tracker` repo, production branch **`main`**.
3. Build settings:
   - **Framework preset:** Hugo
   - **Build command:** `hugo --gc --minify`
   - **Build output directory:** `public`
   - **Environment variable:** `HUGO_VERSION = 0.162.1` (match the local pin; Pages defaults to an
     older Hugo that lacks the `layouts/_partials` + `build:` front-matter this site uses).
4. Save & Deploy. The first build publishes to `<project>.pages.dev` — open it and confirm the
   map/table/detail pages load (same as local).

## 2. Point the subdomain

1. In the new Pages project → **Custom domains** → **Set up a custom domain** → `heat.marybecica.com`.
2. Cloudflare adds the CNAME automatically since `marybecica.com` is on this account. Wait for
   "Active" (usually a minute).
3. Visit `https://heat.marybecica.com/` — done. (The subdomain is independent of the repo name and
   can be changed here anytime; if you change it, update `baseURL` in `hugo.yaml`.)

## 3. Live-data refresh (already wired)

The `fetch-current.yml` GitHub Action commits refreshed `static/data/*` to `main`. Each commit
triggers a Pages rebuild, so new conditions go live automatically. The cron is throttled to
**weekly** for prototyping (`0 17 * * 1`); flip it to `0 */3 * * *` at launch (see
`.github/workflows/fetch-current.yml`). Manual refresh anytime:
`gh workflow run fetch-current.yml --ref main`.

`static/_headers` keeps `/data/*` briefly cached (5 min, revalidated) so a rebuild's new JSON is
picked up quickly; `static/_redirects` is where `build_facilities.py` appends old→home redirects
when a facility closes.

## Phase 4 note — R2

Per SCOPE §3, delivery moves to Cloudflare R2 at Phase 4 (true hourly updates, no build-quota
draw, cleaner git history). The JSON contracts are identical, so the frontend swap is just
changing the `/data/...` fetch base URLs in the `cht-*.js` files. Non-blocking; ships on commits
first.

## Cross-links (optional, personal site)

The tracker footer already links to the Prison Heat Index. If you want a reciprocal link from the
personal site, add one in the `website` repo — the tracker stays untouched by that.
