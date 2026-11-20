# Heat-Level Historical Dataset (`data/heats/`)

Normalized heat-by-heat, start-by-start individual short track speed skating results for ISU World Cup / World Tour, World Championships, and Olympic Winter Games across **2022/23–2025/26** (27 events), aligned with the **2026/27** live feed (`data/competitions/*.json`) and ISU competition rules (`docs/isu_rules_evolution.md`).

## Directory Layout

- `athletes.json` — Master athlete registry keyed by `skr-<official_skater_id>` (merging multiple ISU IDs if needed, tracking association spells `countries[]`, `aliases[]`, and `name_zh`).
- `athlete_crosswalk.json` — Mapping from legacy `ath-<hash>` IDs in `data/competitions/*.json` to `skr-<id>`.
- `events.json` — Event index with heat/start counts, covered disciplines, and provenance sha256 fingerprints.
- `events/<season>-<kind>-<city>[-<n>].json` — Full heat-level records for each of the 27 events (500m / 1000m / 1500m individual events, all rounds: `PRELIM`, `REPECHAGE`, `MAIN`).
- `rules/season_config.json` — Season-level macro rule switches (`has_double_distance`, `lane_mode`, `rep_cap`, `zfs_mode`, etc.).
- `rules/<season>.json` — Per-event, per-round structured qualification rules (`big_q`, `small_q_planned`, `small_q_from_place`, `q_actual`, `n_adv`).

## Key Schema Conventions

- **Case-sensitive qualification flags**:
  - `qual_flag_raw`: exact official code (`Q`, `q`, `QA`, `qA`, `QB`, `qB`, `ADV`, `ADVA`, `ADVB`, or `null`).
  - `qual_type`: `Q` (`Q`/`QA`), `q` (`q`/`qA`), `QB` (`QB`), `qB` (`qB`), `ADV` (`ADV`/`ADVA`/`ADVB`), `OUT` (non-advancing in non-final rounds), or `null` (Final A/B).
  - `qual_target`: `NEXT` | `FA` | `FB` | `null`.
  - `advanced`: `true` iff `qual_type in {"Q", "q", "ADV"}` and `qual_target in {"NEXT", "FA"}`.
- **Status & incident flags**:
  - `OK` (timed finish), `NO_TIME` (Rule 294.24 no-time finish, `time_s: null`), `ADV` (referee advancement, preserves `time_s` if timed), `PEN`, `YC`, `RC` (`is_incident: true, incident_type: "PEN"`), `DNF` (`is_incident: true, incident_type: "DNF"`, eligible for repechage), `DNS` (excluded from `heat_size`, ineligible for repechage).
- **Double-distance & Repechage separation**:
  - `event_distance_instance` distinguishes `(1)` vs `(2)` in 2022/23–2023/24 World Cups and is asserted `1` from 2024/25 onward.
  - `session_type` separates `PRELIM`, `REPECHAGE`, and `MAIN` so `Rep. Quarterfinals` / `Rep. Semifinals` never collide with main-draw `QF`/`SF`.
  - `is_repechage_qualifier` marks the 2 `Rep. Semifinals` winners entering the main draw.
- **Timestamps**:
  - ISU API `heat.date` values are local wall-clock times mislabeled with `.000Z`. `start_time_utc` is converted using verified venue IANA timezones.
- **Lane assignment (`lane_mode`)**:
  - Empirically verified in `docs/data_audit.md`: 2022/23–2025/26 SF→Final starting positions used `time_first`; `rank_then_time` (Rule 293.7) took effect in 2026/27.

## Reproduction Commands

```bash
python3 tools/import_heats.py --offline          # Deterministic rebuild from .cache/isu/
python3 tools/build_rules.py                     # Build rules/<season>.json & backfill heat qualification
python3 tools/check_heats.py                     # Validate invariants & generate docs/data_coverage.md
python3 tools/export_heat_starts.py              # Export build/heat_starts.{jsonl,csv}
python3 -m unittest discover -s tests -v         # Run full test suite including tests/test_heats.py
```
