#!/usr/bin/env python3
"""Phase 2 gate: prove Earth Engine works **headless**, then sanity-check the read.

Phase 1 scripts init EE with `ee.Initialize(project=...)`, which silently reuses the
interactive `~/.config/earthengine/credentials` from `earthengine authenticate`.
GitHub Actions has no such creds. We authenticate CI with **Workload Identity
Federation** (no downloaded key): `google-github-actions/auth` exchanges the runner's
OIDC token for short-lived credentials and exports them as Application Default
Credentials, which this script picks up via `google.auth.default()` with the Earth
Engine scope. It then runs one RTMA point query at a real facility and cross-checks it
against the keyless NWS NDFD forecast, so we know the SA can actually *read data*.

Auth source (auto-detected, in order):
    federated / ADC   CI: GOOGLE_APPLICATION_CREDENTIALS set by google-github-actions/auth
                      (force with --federated). This is the path the smoke workflow uses.
    $EE_SA_KEY        raw JSON SA key string — only if a key is ever reintroduced
    --key-file PATH   JSON SA key file — likewise a fallback, not the default
    interactive       local: your existing earthengine-authenticate creds (Phase 1 default)

    python3 pipeline/validate_ee_headless.py                # local, interactive creds
    python3 pipeline/validate_ee_headless.py --federated    # CI, WIF-provided ADC

Exit 0 = auth + data read + sane vs NDFD. Non-zero = gate not passed. A pass under
--federated in Actions proves the keyless CI auth works before we build fetch_current.py.
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import ee

# EE needs the earthengine scope; cloud-platform covers the serviceusage check that
# the "Service Usage Consumer" role backs. Federated ADC starts un-scoped, so we must
# request these explicitly — a bare google.auth.default() will auth but fail on read.
EE_SCOPES = ["https://www.googleapis.com/auth/earthengine",
             "https://www.googleapis.com/auth/cloud-platform"]

# Chuckawalla Valley State Prison — Colorado Desert, reliably hot in July,
# so a plausible-temperature sanity check has real signal.
TEST_SLUG = "chuckawalla-valley-state-prison-cvsp"
TEST_LAT, TEST_LON = 33.562579498036335, -114.90950576295587
RTMA = "NOAA/NWS/RTMA"
TZ = ZoneInfo("America/Los_Angeles")
UA = "ca-carceral-heat-tracker/validation (m.becica@gmail.com)"


def init_ee(key_file=None, federated=False):
    """Initialize Earth Engine, auto-detecting the auth source (see module docstring).

    The federated/ADC path is the one CI uses: google-github-actions/auth has already
    written short-lived, WIF-derived credentials, so we ask google.auth.default() for
    them *with* the EE scopes and hand them to ee.Initialize — no key anywhere."""
    project = os.environ.get("EE_PROJECT", "ca-carceral-heat")
    want_federated = federated or bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"))

    if key_file:
        creds = ee.ServiceAccountCredentials(None, key_file=key_file)
        ee.Initialize(creds, project=project)
        src, who = f"key_file={key_file}", _peek_sa_email(key_file=key_file)
    elif os.environ.get("EE_SA_KEY"):
        creds = ee.ServiceAccountCredentials(None, key_data=os.environ["EE_SA_KEY"])
        ee.Initialize(creds, project=project)
        src, who = "env EE_SA_KEY", _peek_sa_email(key_data=os.environ["EE_SA_KEY"])
    elif want_federated:
        import google.auth
        creds, _ = google.auth.default(scopes=EE_SCOPES)
        ee.Initialize(creds, project=project)
        src, who = "federated ADC (WIF)", getattr(creds, "service_account_email", None)
    else:
        ee.Initialize(project=project)  # local interactive creds (Phase 1 default)
        src, who = "interactive creds", None

    print(f"✓ EE initialized via {src} (project={project})")
    if who:
        print(f"  identity: {who}")


def _peek_sa_email(key_file=None, key_data=None):
    try:
        blob = json.load(open(key_file)) if key_file else json.loads(key_data)
        return blob.get("client_email")
    except Exception:
        return None


def rtma_latest(lat, lon):
    """Most-recent non-null RTMA 2 m temperature at the point, in °F, with its
    local timestamp. Looks back 72 h — the GEE RTMA collection lags real time by
    several hours, so a tight window can be empty ('No bands in collection')."""
    pt = ee.Geometry.Point(lon, lat)
    col = (ee.ImageCollection(RTMA).select("TMP")
           .filterDate(ee.Date(_now_utc_iso(-72)), ee.Date(_now_utc_iso(1))))
    if col.size().getInfo() == 0:
        raise SystemExit("RTMA collection empty over last 72 h — data read failed.")
    rows = col.getRegion(pt, 2500).getInfo()
    latest = None
    for r in rows[1:]:
        t_ms, tmp = r[3], r[4]
        if tmp is None:
            continue
        if latest is None or t_ms > latest[0]:
            latest = (t_ms, tmp)
    if latest is None:
        raise SystemExit("RTMA returned no temperature — data read failed.")
    t_ms, tmp_c = latest
    when = datetime.fromtimestamp(t_ms / 1000, timezone.utc).astimezone(TZ)
    return round(tmp_c * 9 / 5 + 32, 1), when


def _now_utc_iso(hours_delta):
    # ee.Date accepts ms epoch; build one relative to "now" without Date.now()
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    return now_ms + hours_delta * 3600 * 1000


def ndfd_high_today(lat, lon):
    """Keyless NWS: today's daytime forecast high (°F) at the point. This is the
    same NDFD product fetch_current.py will use for the current-day high."""
    def get(url):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    pts = get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
    fc = get(pts["properties"]["forecast"])
    for p in fc["properties"]["periods"]:
        if p.get("isDaytime"):
            return float(p["temperature"]), p["name"]  # NWS periods report °F
    return None, None


def main():
    ap = argparse.ArgumentParser(description="Validate headless Earth Engine auth + data read")
    ap.add_argument("--federated", action="store_true",
                    help="force the WIF/ADC path (auto-detected in CI via GOOGLE_APPLICATION_CREDENTIALS)")
    ap.add_argument("--key-file", help="fallback: path to a JSON SA key outside the repo")
    args = ap.parse_args()

    init_ee(key_file=args.key_file, federated=args.federated)

    print(f"\nPoint query @ {TEST_SLUG} ({TEST_LAT:.4f}, {TEST_LON:.4f}):")
    rtma_f, when = rtma_latest(TEST_LAT, TEST_LON)
    print(f"  RTMA latest analysis: {rtma_f}°F  @ {when:%Y-%m-%d %H:%M %Z}")

    try:
        ndfd_f, period = ndfd_high_today(TEST_LAT, TEST_LON)
        print(f"  NDFD forecast high:   {ndfd_f}°F  ({period})")
    except Exception as e:
        ndfd_f = None
        print(f"  NDFD lookup failed ({e}); falling back to plausibility-only check.")

    # Sanity: RTMA must be an earthly temperature, and — since an analysis-now
    # reading and a forecast daytime-high differ by time of day — within a loose
    # band of the NDFD high. Wide tolerance: we're proving the pipe, not calibrating.
    ok = -20 <= rtma_f <= 135
    if ndfd_f is not None:
        gap = abs(rtma_f - ndfd_f)
        ok = ok and gap <= 30
        print(f"\n  |RTMA − NDFD| = {gap:.1f}°F (tolerance 30°F for now-vs-high)")
    if ok:
        print("\n✅ GATE PASSED — auth + live EE data read + NDFD sanity all OK.")
        return 0
    print("\n❌ GATE FAILED — value implausible or far from NDFD; investigate before building fetch_current.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
