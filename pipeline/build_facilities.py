#!/usr/bin/env python3
"""Build the all-facility data bundle for the California Carceral Facility Heat Tracker.

Exports every OPEN California carceral facility (~357: county, state, local,
federal, multi-jurisdiction) to the app repo, mirroring the Prison Heat Index
`build_app_data.py` pattern but scaled to all facilities:

  - facility master JSON (statewide map/table + detail pages read this)
  - per-facility Hugo content stubs (declaratively managed: adds new, deletes
    closed, appends Cloudflare `_redirects` lines so removed URLs don't 404)
  - simplified boundary polygons GeoJSON (high-zoom map layer)
  - persistent slug registry (`slugs.csv`, committed here) so detail-page URLs
    never change across refreshes, even if HiFLD renames a facility; retired
    slugs are never reused.

Thresholds come from `data/baselines.csv` (built by `build_baselines.py`); if
that file is missing the export still runs with null thresholds and a warning.

Run whenever the facility list or CDCR extras change (see REFRESH.md at the
repo root):

    python3 analysis/heatwave_app/build_facilities.py

Outputs (into the sibling `ca-carceral-heat-tracker` repo):
    static/data/facilities.json           facility master (map, table, detail pages)
    static/data/facility_boundaries.geojson
    content/facilities/<slug>.md          routable detail-page stubs (url: /<slug>/)
    static/_redirects                     managed block for retired facility URLs
"""
import argparse
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

import pandas as pd
from shapely import wkt
from shapely.geometry import mapping

HERE = Path(__file__).resolve().parent                    # <app repo>/pipeline/
APP = HERE.parent                                         # ca-carceral-heat-tracker/
CJ = APP.parent / "ca_prison_climate_justice"             # sibling open-data repo (inputs)

FAC_CSV = CJ / "data_sources/facilities/ca_facilities.csv"
CDCR_CSV = CJ / "data/cdcr/cdcr_facilities.csv"
BASELINES_CSV = HERE / "data/baselines.csv"
PHI_JSON = CJ / "analysis/app_export/output/prison_heat_index.json"
REGISTRY_CSV = HERE / "data/slugs.csv"

STUB_DIR = APP / "content/facilities"
DATA_DIR = APP / "static/data"
REDIRECTS = APP / "static/_redirects"
REDIRECT_BEGIN = "# BEGIN retired facility redirects (managed by build_facilities.py)"
REDIRECT_END = "# END retired facility redirects"

THRESHOLD_DELTA_F = 10.0
BASELINE_PERIOD = "1991-2020"

# --- Data vintages, rendered into meta and shown in the UI. -------------------
# Update at each base-data refresh (see REFRESH.md at the repo root). Population
# and CCHCS years are discovered from column names; these are the rest.
FACILITY_LIST_AS_OF = "2025-07"   # HiFLD/FEMA download vintage
COOLING_AS_OF = "2025-12"         # CDCR Air Cooling Pilot Supplemental Report (Jan 2026) + Reuters FOIA 2025


def slugify(name):
    s = str(name).lower().replace("&", " and ")
    s = re.sub(r"[''`’]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def num(v, digits=None):
    """NaN -> None; optionally round; keep ints clean."""
    if v is None or pd.isna(v):
        return None
    v = float(v)
    if digits is not None:
        v = round(v, digits)
    return int(v) if v == int(v) else v


def text(v, title=False):
    if v is None or pd.isna(v):
        return None
    s = str(v).strip()
    return s.title() if title else s


def bool_from(v):
    if v is None or pd.isna(v):
        return None
    s = str(v).strip().lower()
    if s in ("yes", "true", "1", "1.0"):
        return True
    if s in ("no", "false", "0", "0.0", ""):
        return False
    return True  # any non-empty descriptive value counts as present


def full_address(f):
    """Compose 'street, City, ST zip' from the facility row; None if no street."""
    if pd.isna(f.get("address")):
        return None
    street = str(f["address"]).strip()
    city = "" if pd.isna(f.get("city")) else str(f["city"]).title()
    state = "" if pd.isna(f.get("state")) else str(f["state"]).upper()
    zc = "" if pd.isna(f.get("zip")) else str(int(float(f["zip"]))).zfill(5)
    tail = " ".join(x for x in (state, zc) if x)
    head = ", ".join(x for x in (street, city) if x)
    return ", ".join(x for x in (head, tail) if x)


def discover_year_column(df, pattern):
    """Find e.g. average_2025_population and return (column, year) or (None, None)."""
    for col in df.columns:
        m = re.fullmatch(pattern, col)
        if m:
            return col, int(m.group(1))
    return None, None


# ---------------------------------------------------------------------------
# Slug registry: facilityid -> slug, persistent across refreshes
# ---------------------------------------------------------------------------

def load_registry():
    """Returns {facilityid(int): row dict}. Empty if no registry yet."""
    if not REGISTRY_CSV.exists():
        return {}
    reg = {}
    with open(REGISTRY_CSV) as f:
        for row in csv.DictReader(f):
            reg[int(row["facilityid"])] = row
    return reg


def save_registry(reg):
    rows = sorted(reg.values(), key=lambda r: r["slug"])
    with open(REGISTRY_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["facilityid", "slug", "name", "first_seen", "retired"])
        w.writeheader()
        w.writerows(rows)


def assign_slugs(fac, reg):
    """Give every current facility a stable slug; retire registry rows for
    facilities no longer in the list. Returns (facilityid->slug, newly_retired)."""
    today = date.today().isoformat()
    taken = {r["slug"] for r in reg.values()}          # incl. retired: never reuse
    current_ids = set(fac["facilityid"].astype(int))

    for _, f in fac.iterrows():
        fid = int(f["facilityid"])
        if fid in reg:
            if reg[fid]["retired"]:                     # facility came back
                print(f"  note: {reg[fid]['slug']} was retired, un-retiring (facility reappeared)")
                reg[fid]["retired"] = ""
            reg[fid]["name"] = f["name"]                # track renames, slug unchanged
            continue
        slug = slugify(f["name"])
        if slug in taken:
            slug = f"{slug}-{slugify(f['county'])}"
        if slug in taken:
            slug = f"{slug}-{fid}"
        taken.add(slug)
        reg[fid] = {"facilityid": str(fid), "slug": slug, "name": f["name"],
                    "first_seen": today, "retired": ""}

    newly_retired = []
    for fid, row in reg.items():
        if fid not in current_ids and not row["retired"]:
            row["retired"] = today
            newly_retired.append(row["slug"])
    return {int(r["facilityid"]): r["slug"] for r in reg.values()}, newly_retired


# ---------------------------------------------------------------------------
# Declarative stub + redirect management
# ---------------------------------------------------------------------------

def write_stubs(facilities):
    """One thin routable Hugo content file per facility; body renders client-side.
    This script owns content/facilities/: stubs not in the current set are deleted."""
    STUB_DIR.mkdir(parents=True, exist_ok=True)
    current = set()
    for f in facilities:
        current.add(f["slug"] + ".md")
        fm = (
            "---\n"
            f'title: "{f["name"]}"\n'
            f'slug: "{f["slug"]}"\n'
            f'url: "/{f["slug"]}/"\n'
            f"facilityid: {f['id']}\n"
            "type: facility\n"
            "layout: single\n"
            f'summary: "Current heat conditions at {f["name"]}, a {f["jurisdiction"].lower()}'
            f' facility in {f["county"]} County, California."\n'
            "---\n"
        )
        (STUB_DIR / f"{f['slug']}.md").write_text(fm)

    # Non-rendering section index so /facilities/ never emits a stray list page.
    current.add("_index.md")
    (STUB_DIR / "_index.md").write_text(
        '---\ntitle: "Facilities"\nbuild:\n  render: never\n  list: never\n---\n'
    )

    orphans = [p for p in STUB_DIR.glob("*.md") if p.name not in current]
    for p in orphans:
        p.unlink()
        print(f"  deleted orphan stub: {p.name}")
    print(f"Wrote {len(facilities)} content stubs -> {STUB_DIR} ({len(orphans)} orphans removed)")


def update_redirects(reg):
    """Rewrite the managed block in static/_redirects: one line per retired
    facility, redirecting its old detail URL to the home page."""
    retired = sorted(r["slug"] for r in reg.values() if r["retired"])
    lines = [REDIRECT_BEGIN] + [f"/{slug}/ / 302" for slug in retired] + [REDIRECT_END]

    existing = REDIRECTS.read_text().splitlines() if REDIRECTS.exists() else []
    if REDIRECT_BEGIN in existing:
        i, j = existing.index(REDIRECT_BEGIN), existing.index(REDIRECT_END)
        out = existing[:i] + lines + existing[j + 1:]
    else:
        out = existing + ([""] if existing else []) + lines
    REDIRECTS.parent.mkdir(parents=True, exist_ok=True)
    REDIRECTS.write_text("\n".join(out) + "\n")
    if retired:
        print(f"Redirects: {len(retired)} retired facility URL(s) -> /")


def write_boundaries(facilities, fac_by_id):
    """Facility boundary polygons (FEMA/HiFLD WKT -> GeoJSON), simplified for the
    high-zoom map layer. Keyed by slug."""
    feats = []
    for f in facilities:
        raw = fac_by_id.loc[f["id"]].get("geometry")
        if pd.isna(raw):
            continue
        geom = wkt.loads(raw).simplify(0.0001, preserve_topology=True)
        feats.append({
            "type": "Feature",
            "properties": {"slug": f["slug"], "name": f["name"]},
            "geometry": mapping(geom),
        })
    fc = {"type": "FeatureCollection", "features": feats}
    out = DATA_DIR / "facility_boundaries.geojson"
    out.write_text(json.dumps(fc, ensure_ascii=False))
    print(f"Wrote {len(feats)} boundaries -> {out} ({out.stat().st_size/1024:.0f} KB)")


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------

def cdcr_block(f, cchcs_year, phi_slugs):
    """CDCR-prison extras (cooling pie, vulnerability stats, PHI cross-link).
    Only for facilities with a cdcr_code; fire camps and non-CDCR get None."""
    code = text(f.get("cdcr_code"))
    if code is None:
        return None
    yy = cchcs_year
    return {
        "code": code,
        "year_opened": num(f.get("year_opened")),
        "planned_closure": bool_from(f.get("planned_closure")),
        "air_cooling_pilot": bool_from(f.get("cdcr_air_cooling_pilot")),
        "cooling": {
            "pct_units_refrigeration": num(f.get("pct_units_refrigeration"), 4),
            "pct_units_evaporation": num(f.get("pct_units_evaporation"), 4),
            "pct_units_ventilation": num(f.get("pct_units_ventilation"), 4),
            "n_housing_units": num(f.get("n_housing_units")),
        },
        "demographics": {
            # gender/race are 0-1 fractions in source; CCHCS *_pct already percentages
            "female_pct": None if pd.isna(f.get("gender_female_pct")) else num(f["gender_female_pct"] * 100, 1),
            "poc_pct": None if pd.isna(f.get("race_peopleofcolor_pct")) else num(f["race_peopleofcolor_pct"] * 100, 1),
            "age_over_50_pct": num(f.get(f"cchcs_age_over_50_pct_{yy}"), 1),
        },
        "medical": {
            "mental_health_eop_pct": num(f.get(f"cchcs_mental_health_eop_pct_{yy}"), 1),
            "dpp_pct": num(f.get(f"cchcs_dpp_pct_{yy}"), 1),
            "high_risk_p1_pct": num(f.get(f"cchcs_high_risk_p1_pct_{yy}"), 1),
            "high_risk_p2_pct": num(f.get(f"cchcs_high_risk_p2_pct_{yy}"), 1),
            "medium_risk_pct": num(f.get(f"cchcs_medium_risk_pct_{yy}"), 1),
        },
        "phi_slug": phi_slugs.get(code),
    }


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()

    if not APP.exists():
        sys.exit(f"App repo not found at {APP} — clone/create it first.")

    fac = pd.read_csv(FAC_CSV)
    fac = fac[fac["status"] == "OPEN"].copy()
    fac["facilityid"] = fac["facilityid"].astype(int)
    print(f"{len(fac)} OPEN facilities from {FAC_CSV.name}")

    cdcr = pd.read_csv(CDCR_CSV)
    cdcr["facilityid"] = cdcr["facilityid"].astype(int)
    pop_col, pop_year = discover_year_column(cdcr, r"average_(\d{4})_population")
    cap_col, _ = discover_year_column(cdcr, r"capacity_percent_(\d{4})")
    _, cchcs_year = discover_year_column(cdcr, r"cchcs_dpp_pct_(\d{4})")
    print(f"CDCR extras: population column {pop_col}, CCHCS year {cchcs_year}")
    cdcr_by_id = cdcr.set_index("facilityid")

    baselines = {}
    if BASELINES_CSV.exists():
        b = pd.read_csv(BASELINES_CSV)
        baselines = b.set_index("facilityid")["baseline_summer_avg_tmax_f"].to_dict()
        print(f"Baselines: {len(baselines)} facilities from {BASELINES_CSV.relative_to(APP)}")
    else:
        print(f"WARNING: {BASELINES_CSV.relative_to(APP)} not found — thresholds will be null "
              "(run build_baselines.py, then rerun this)")

    phi_slugs = {}
    if PHI_JSON.exists():
        phi = json.loads(PHI_JSON.read_text())
        phi_slugs = {p["code"]: p["slug"] for p in phi["prisons"]}

    reg = load_registry()
    slug_of, newly_retired = assign_slugs(fac, reg)
    save_registry(reg)
    if newly_retired:
        print(f"Retired {len(newly_retired)} facility slug(s): {', '.join(newly_retired)}")

    facilities = []
    missing_baseline = []
    for _, f in fac.iterrows():
        fid = int(f["facilityid"])
        c = cdcr_by_id.loc[fid] if fid in cdcr_by_id.index else None
        cd = cdcr_block(c, cchcs_year, phi_slugs) if c is not None else None

        # population: CDCR TPOP-1 annual average (dated) beats the undated HiFLD figure
        pop, pop_asof = None, None
        if c is not None and pop_col and not pd.isna(c.get(pop_col)):
            pop, pop_asof = num(c[pop_col]), str(pop_year)
        elif not pd.isna(f.get("population")):
            pop, pop_asof = num(f["population"]), None      # HiFLD, vintage unknown

        capacity_pct = None
        if c is not None and cap_col and not pd.isna(c.get(cap_col)):
            capacity_pct = num(c[cap_col], 3)
        elif not pd.isna(f.get("capacity_percent")):
            capacity_pct = num(f["capacity_percent"], 3)

        baseline = baselines.get(fid)
        if baseline is None:
            missing_baseline.append(fid)

        facilities.append({
            "id": fid,
            "slug": slug_of[fid],
            "name": text(f["name"]),
            "county": text(f["county"], title=True),
            "city": text(f.get("city"), title=True),
            "address": full_address(f),
            "jurisdiction": text(f["type"], title=True),
            "security": text(f.get("securelvl"), title=True),
            "website": text(f.get("website")),
            "lat": num(f["latitude"], 5),
            "lon": num(f["longitude"], 5),
            "population": pop,
            "population_as_of": pop_asof,
            "capacity": num(f.get("capacity")),
            "capacity_pct": capacity_pct,
            "baseline_summer_avg_high_f": num(baseline, 1),
            "threshold_f": num(baseline + THRESHOLD_DELTA_F, 1) if baseline is not None else None,
            "cdcr": cd,
        })

    facilities.sort(key=lambda p: p["name"])
    if missing_baseline:
        print(f"WARNING: {len(missing_baseline)} facilities have no baseline/threshold")

    bundle = {
        "meta": {
            "n_facilities": len(facilities),
            "jurisdictions": sorted(fac["type"].str.title().value_counts().to_dict().items()),
            "threshold": {
                "delta_f": THRESHOLD_DELTA_F,
                "baseline_period": BASELINE_PERIOD,
                "baseline_months": "June-August",
                "note": f"Threshold = {THRESHOLD_DELTA_F:.0f}°F above the facility's "
                        f"{BASELINE_PERIOD} June–August average daily high "
                        f"(PRISM 30-year normals).",
            },
            "vintages": {
                "facility_list_as_of": FACILITY_LIST_AS_OF,
                "population_cdcr_as_of": str(pop_year) if pop_year else None,
                "population_other_as_of": None,   # HiFLD population is undated
                "cooling_as_of": COOLING_AS_OF,
                "vulnerability_as_of": str(cchcs_year) if cchcs_year else None,
            },
            "built": date.today().isoformat(),
        },
        "facilities": facilities,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(bundle, ensure_ascii=False, indent=1)
    out = DATA_DIR / "facilities.json"
    out.write_text(payload)
    print(f"Wrote {len(facilities)} facilities -> {out} ({len(payload)/1024:.0f} KB)")

    write_stubs(facilities)
    update_redirects(reg)
    write_boundaries(facilities, fac.set_index("facilityid"))


if __name__ == "__main__":
    main()
