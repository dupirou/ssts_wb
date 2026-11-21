#!/usr/bin/env python3
"""Domestic Chinese Short Track (甲组/乙组) official result PDF parser & CSV override merger.

Extracts structured 6-column tables (名次 / 号码 / 姓名 / 代表单位 / 积分 / 备注) via
coordinate-aware pypdf visitor_text (no OCR, no hardcoded column pixel offsets).
Features:
  - Header metadata regex extraction: venue, division, gender, distance_m, report_date
  - Automatic single-stop vs cumulative points detection (0.85 geometric decay check)
  - Strict tied-rank preservation
  - Composite-key (name_zh, team) disambiguation via config/chn_name_mapping.yaml
  - Explicit warning list + deterministic dom-tmp-* IDs for unknown/ambiguous names (zero silent drops)
  - Optional CSV override for best_time_s and is_relay_member
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PYLIB = ROOT / '.cache/pylib'
if PYLIB.exists() and str(PYLIB) not in sys.path:
    sys.path.insert(0, str(PYLIB))

from pypdf import PdfReader
import yaml

DEFAULT_RULES_PATH = ROOT / 'config/quota_rules_2026_27.yaml'
DEFAULT_MAPPING_PATH = ROOT / 'config/chn_name_mapping.yaml'
DEFAULT_OUT_PATH = ROOT / 'data/quota_roster/domestic_recent_results.json'

COLUMN_ALIASES = {
    'rank': ('名次', '排名', 'rank'),
    'bib': ('号码', '头盔号', '编号', 'bib'),
    'name': ('姓名', '运动员', 'name'),
    'team': ('代表单位', '单位', '代表队', 'team'),
    'points': ('积分', '总积分', '得分', 'points'),
    'notes': ('备注', '说明', 'notes', 'remark'),
}

# Expected single-stop geometric decay sequence: 10000 * 0.85^(r-1)
GEOMETRIC_TOP4 = (10000, 8500, 7225, 6141)


def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open('r', encoding='utf-8') as fh:
        return yaml.safe_load(fh) or {}


def detect_is_cumulative(rows: list[dict]) -> bool:
    """Return False if top-4 points follow single-stop 10000 * 0.85^(r-1) decay; else True."""
    by_rank: dict[int, list[float]] = {}
    for row in rows:
        rk = row.get('rank')
        pts = row.get('points')
        if isinstance(rk, int) and 1 <= rk <= 4 and isinstance(pts, (int, float)):
            by_rank.setdefault(rk, []).append(float(pts))
    if not all(r in by_rank for r in (1, 2, 3, 4)):
        return True
    for r, expected in enumerate(GEOMETRIC_TOP4, 1):
        # Allow +/- 2 rounding tolerance (ISU rounding uses round(10000 * 0.85^(r-1)))
        if not any(abs(v - expected) <= 2.0 for v in by_rank[r]):
            return True
    return False


def parse_header_metadata(header_lines: list[str]) -> dict:
    """Extract venue, division, gender, distance_m, report_date, title from header text lines."""
    joined = '\n'.join(header_lines)

    # Venue: e.g. 七台河体育中心, 首都体育馆, 黑龙江省冰上训练中心, etc.
    venue = None
    venue_m = re.search(
        r'(?:场馆|地点|比赛地点)[:：]?\s*([^\s,，;；]+)|([\u4e00-\u9fffA-Za-z0-9]{2,20}(?:体育中心|体育馆|冰上(?:运动)?训练中心|滑冰馆|冰场|综合馆))',
        joined,
    )
    if venue_m:
        venue = (venue_m.group(1) or venue_m.group(2) or '').strip()

    # Division: 甲组 / 乙组 / 成年组 / 青年组 / 公开组
    div_m = re.search(r'(甲组|乙组|成年组|青年组|公开组)', joined)
    division = div_m.group(1) if div_m else '甲组'

    # Gender
    gender = None
    if re.search(r'女子组?|女\s*\d{3,4}', joined):
        gender = 'women'
    elif re.search(r'男子组?|男\s*\d{3,4}', joined):
        gender = 'men'

    # Distance
    dist_m = re.search(r'(1500|1000|500)\s*(?:米|m|M)', joined)
    distance_m = int(dist_m.group(1)) if dist_m else None

    # Report / print date: 打印时间: 2026-10-18 ... or 2026/10/18 or 2026年10月18日
    report_date = None
    date_m = re.search(
        r'(?:打印时间|日期|时间)[:：]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})',
        joined,
    ) or re.search(r'(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})', joined)
    if date_m:
        report_date = f'{int(date_m.group(1)):04d}-{int(date_m.group(2)):02d}-{int(date_m.group(3)):02d}'

    # Title hint
    title = next((l.strip() for l in header_lines if l.strip()), '')
    return {
        'title': title,
        'venue': venue,
        'division': division,
        'gender': gender,
        'distance_m': distance_m,
        'report_date': report_date,
    }


def _group_pdf_page_rows(page, y_tol: float = 4.0) -> list[tuple[float, list[tuple[float, str]]]]:
    """Extract (y, [(x, text), ...]) rows from a pypdf page via visitor_text."""
    items: list[tuple[float, float, str]] = []

    def visitor(text, cm, tm, font_dict, font_size):
        t = text.strip()
        if t:
            items.append((round(float(tm[5]), 1), round(float(tm[4]), 1), t))

    page.extract_text(visitor_text=visitor)
    if not items:
        return []
    items.sort(key=lambda z: (-z[0], z[1]))
    rows: list[tuple[float, list[tuple[float, str]]]] = []
    for y, x, t in items:
        if rows and abs(rows[-1][0] - y) <= y_tol:
            rows[-1][1].append((x, t))
        else:
            rows.append((y, [(x, t)]))
    for _, cells in rows:
        cells.sort(key=lambda c: c[0])
    return rows


def _identify_column_key(text: str) -> str | None:
    clean = re.sub(r'\s+', '', text).lower()
    for key, aliases in COLUMN_ALIASES.items():
        if any(a.lower() == clean for a in aliases):
            return key
    return None


def _detect_header_columns(rows: list[tuple[float, list[tuple[float, str]]]]) -> tuple[int, dict[str, float]] | None:
    """Find table header row index and exact x-coordinate anchors for each recognized column."""
    for idx, (_, cells) in enumerate(rows):
        found: dict[str, float] = {}
        for x, text in cells:
            # Handle merged cell text split by whitespace if PDF emitted header in one span
            parts = text.split()
            if len(parts) > 1 and all(_identify_column_key(p) for p in parts):
                # Approximate proportional x offsets when header is a single text run
                step = 75.0
                for j, p in enumerate(parts):
                    ck = _identify_column_key(p)
                    if ck:
                        found[ck] = x + j * step
            else:
                ck = _identify_column_key(text)
                if ck:
                    found[ck] = x
        if {'rank', 'name', 'team'}.issubset(found):
            return idx, found
    return None


def _assign_cells_to_columns(cells: list[tuple[float, str]], col_anchors: dict[str, float]) -> dict[str, str]:
    """Assign each (x, text) token to its nearest header column anchor."""
    ordered = sorted(col_anchors.items(), key=lambda kv: kv[1])
    buckets: dict[str, list[str]] = {k: [] for k, _ in ordered}
    for x, text in cells:
        best_key = min(ordered, key=lambda kv: abs(x - kv[1]))[0]
        buckets[best_key].append(text)
    return {k: ' '.join(v).strip() for k, v in buckets.items()}


def _parse_row_from_plain_line(line: str) -> dict | None:
    """Fallback parser when a single PDF text run contains whitespace-separated columns."""
    m = re.match(
        r'^\s*(\d+)\s+([A-Za-z0-9-]+)\s+([\u4e00-\u9fff·A-Za-z]+)\s+([^\s]+)\s+([0-9]+(?:\.[0-9]+)?)\s*(.*)$',
        line.strip(),
    )
    if not m:
        return None
    return {
        'rank': int(m.group(1)),
        'bib': m.group(2),
        'name_zh': m.group(3).strip(),
        'team': m.group(4).strip(),
        'points': float(m.group(5)) if '.' in m.group(5) else int(m.group(5)),
        'notes': m.group(6).strip(),
    }


def parse_domestic_pdf(
    pdf_path: Path,
    *,
    allowed_divisions: set[str] | None = None,
) -> dict:
    """Parse one domestic result PDF into metadata + raw structured rows (preserving tied ranks)."""
    reader = PdfReader(str(pdf_path))
    header_lines: list[str] = []
    parsed_rows: list[dict] = []
    col_anchors: dict[str, float] | None = None

    for page_no, page in enumerate(reader.pages, 1):
        grouped = _group_pdf_page_rows(page)
        detected = _detect_header_columns(grouped)
        start_idx = 0
        if detected is not None:
            hdr_idx, col_anchors = detected
            if page_no == 1:
                for _, cells in grouped[:hdr_idx]:
                    header_lines.append(' '.join(t for _, t in cells))
            start_idx = hdr_idx + 1
        elif page_no == 1:
            # Fallback to plain lines for header
            plain_lines = (page.extract_text() or '').splitlines()
            header_lines.extend(plain_lines[:8])

        for _, cells in grouped[start_idx:]:
            joined = ' '.join(t for _, t in cells).strip()
            if not joined or re.match(r'^(?:第\s*\d+\s*页|Page\s*\d+|打印时间|裁判长|记录长)', joined):
                continue
            if col_anchors and len(cells) >= 3:
                mapped = _assign_cells_to_columns(cells, col_anchors)
                rank_str = mapped.get('rank', '')
                if not re.fullmatch(r'\d+', rank_str):
                    fallback = _parse_row_from_plain_line(joined)
                    if fallback:
                        parsed_rows.append(fallback)
                    continue
                pts_raw = mapped.get('points', '').replace(',', '')
                pts: int | float | None = None
                if re.fullmatch(r'\d+(?:\.\d+)?', pts_raw):
                    pts = float(pts_raw) if '.' in pts_raw else int(pts_raw)
                parsed_rows.append(
                    {
                        'rank': int(rank_str),
                        'bib': mapped.get('bib', ''),
                        'name_zh': re.sub(r'\s+', '', mapped.get('name', '')),
                        'team': mapped.get('team', '').strip(),
                        'points': pts,
                        'notes': mapped.get('notes', '').strip(),
                    }
                )
            else:
                fallback = _parse_row_from_plain_line(joined)
                if fallback:
                    parsed_rows.append(fallback)

    meta = parse_header_metadata(header_lines)
    is_cum = detect_is_cumulative(parsed_rows)
    included = True
    if allowed_divisions is not None and meta['division'] not in allowed_divisions:
        included = False

    return {
        'source_file': str(pdf_path.name),
        'metadata': meta,
        'included_by_division_filter': included,
        'is_cumulative': is_cum,
        'row_count': len(parsed_rows),
        'rows': parsed_rows,
    }


# ------------------------------------------------------------------------------
# Composite-key (name_zh, team) Disambiguation (Zero Silent Drops)
# ------------------------------------------------------------------------------


def _temp_domestic_id(name_zh: str, team: str, gender: str | None) -> str:
    key = f'{gender or "u"}|{name_zh.strip()}|{team.strip()}'
    digest = hashlib.sha1(key.encode('utf-8')).hexdigest()[:10]
    return f'dom-tmp-{digest}'


def disambiguate_domestic_rows(
    parsed_doc: dict,
    mapping_cfg: dict,
) -> tuple[list[dict], list[dict]]:
    """Map domestic rows using composite key (name_zh, team); emit explicit warnings on unknowns/collisions."""
    athletes = mapping_cfg.get('athletes') or []
    gender = parsed_doc['metadata'].get('gender')

    by_exact: dict[tuple[str, str], list[dict]] = {}
    by_name: dict[str, list[dict]] = {}
    for entry in athletes:
        if gender and entry.get('gender') and entry['gender'] != gender:
            continue
        names = [entry.get('name_zh')] + list(entry.get('aliases_zh') or [])
        teams = list(entry.get('teams') or [])
        for nm in [n for n in names if n]:
            by_name.setdefault(nm, []).append(entry)
            for tm in teams:
                by_exact.setdefault((nm, tm), []).append(entry)

    resolved: list[dict] = []
    warnings: list[dict] = []
    meta = parsed_doc['metadata']

    for row in parsed_doc['rows']:
        name_zh = row['name_zh']
        team = row['team']
        exact_hits = by_exact.get((name_zh, team), [])
        name_hits = by_name.get(name_zh, [])

        athlete_id = None
        name_en = None
        birth_date = None
        match_status = 'exact'

        if len(exact_hits) == 1:
            hit = exact_hits[0]
            athlete_id = hit['athlete_id']
            name_en = hit.get('name_en')
            birth_date = hit.get('birth_date')
        elif len(exact_hits) > 1:
            match_status = 'ambiguous_exact_collision'
            athlete_id = _temp_domestic_id(name_zh, team, gender)
            warnings.append(
                {
                    'kind': 'ambiguous_name_collision',
                    'source_file': parsed_doc['source_file'],
                    'name_zh': name_zh,
                    'team': team,
                    'gender': gender,
                    'candidates': [h['athlete_id'] for h in exact_hits],
                    'assigned_temp_id': athlete_id,
                }
            )
        elif len(name_hits) == 1:
            # Single known athlete with this Chinese name; accept if team is unlisted, warn if team differs
            hit = name_hits[0]
            known_teams = set(hit.get('teams') or [])
            if not known_teams or team in known_teams:
                athlete_id = hit['athlete_id']
                name_en = hit.get('name_en')
                birth_date = hit.get('birth_date')
                match_status = 'name_unique'
            else:
                # Different team for same name -> do NOT silently merge (potential homonym!)
                match_status = 'team_mismatch_homonym_guard'
                athlete_id = _temp_domestic_id(name_zh, team, gender)
                warnings.append(
                    {
                        'kind': 'team_mismatch_possible_homonym',
                        'source_file': parsed_doc['source_file'],
                        'name_zh': name_zh,
                        'team': team,
                        'gender': gender,
                        'known_candidate': hit['athlete_id'],
                        'known_teams': sorted(known_teams),
                        'assigned_temp_id': athlete_id,
                    }
                )
        elif len(name_hits) > 1:
            match_status = 'ambiguous_homonym'
            athlete_id = _temp_domestic_id(name_zh, team, gender)
            warnings.append(
                {
                    'kind': 'ambiguous_homonym',
                    'source_file': parsed_doc['source_file'],
                    'name_zh': name_zh,
                    'team': team,
                    'gender': gender,
                    'candidates': [{'athlete_id': h['athlete_id'], 'teams': h.get('teams') or []} for h in name_hits],
                    'assigned_temp_id': athlete_id,
                }
            )
        else:
            match_status = 'unmapped_new_athlete'
            athlete_id = _temp_domestic_id(name_zh, team, gender)
            warnings.append(
                {
                    'kind': 'unmapped_athlete',
                    'source_file': parsed_doc['source_file'],
                    'name_zh': name_zh,
                    'team': team,
                    'gender': gender,
                    'assigned_temp_id': athlete_id,
                }
            )

        resolved.append(
            {
                'athlete_id': athlete_id,
                'name_zh': name_zh,
                'name_en': name_en,
                'birth_date': birth_date,
                'team': team,
                'gender': gender,
                'distance_m': meta.get('distance_m'),
                'division': meta.get('division'),
                'venue': meta.get('venue'),
                'report_date': meta.get('report_date'),
                'source_file': parsed_doc['source_file'],
                'is_cumulative': parsed_doc['is_cumulative'],
                'rank': row['rank'],
                'bib': row['bib'],
                'points': row['points'],
                'notes': row['notes'],
                'best_time_s': None,
                'is_relay_member': False,
                'match_status': match_status,
            }
        )
    return resolved, warnings


def apply_csv_overrides(records: list[dict], csv_path: Path) -> int:
    """Merge optional manual CSV overrides (best_time_s, is_relay_member) keyed by (name_zh, team, distance_m)."""
    if not csv_path.exists():
        return 0
    overrides: dict[tuple[str, str, int | None], dict] = {}
    with csv_path.open('r', encoding='utf-8-sig', newline='') as fh:
        for row in csv.DictReader(fh):
            nm = (row.get('name_zh') or '').strip()
            tm = (row.get('team') or '').strip()
            dist = int(row['distance_m']) if (row.get('distance_m') or '').strip().isdigit() else None
            if not nm:
                continue
            overrides[(nm, tm, dist)] = row

    updated = 0
    for rec in records:
        ov = overrides.get((rec['name_zh'], rec['team'], rec['distance_m'])) or overrides.get(
            (rec['name_zh'], rec['team'], None)
        )
        if not ov:
            continue
        bt = (ov.get('best_time_s') or '').strip()
        if bt:
            rec['best_time_s'] = float(bt)
        rel = (ov.get('is_relay_member') or '').strip().lower()
        if rel in ('1', 'true', 'yes', 'y'):
            rec['is_relay_member'] = True
        elif rel in ('0', 'false', 'no', 'n'):
            rec['is_relay_member'] = False
        updated += 1
    return updated


def parse_domestic_markdown(
    md_path: Path,
    *,
    allowed_divisions: set[str] | None = None,
) -> list[dict]:
    """Parse multi-section domestic Markdown exports (e.g. `# 衡水｜甲组男女单项积分排名` + `## 女子组 500米`).

    Preserves exact tied ranks, blank ranks (rank=None), leading-zero bibs, and zero points.
    """
    text = md_path.read_text(encoding='utf-8')
    lines = text.splitlines()
    top_header: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    current_heading: str | None = None
    current_lines: list[str] = []

    for line in lines:
        if line.startswith('## '):
            if current_heading is not None:
                sections.append((current_heading, current_lines))
            current_heading = line[3:].strip()
            current_lines = []
        elif current_heading is None:
            top_header.append(line)
        else:
            current_lines.append(line)
    if current_heading is not None:
        sections.append((current_heading, current_lines))
    elif lines:
        sections.append(('', lines))

    # Extract venue from H1 title like `# 衡水｜甲组男女单项积分排名` if not matched by standard suffix regex
    h1 = next((l[2:].strip() for l in top_header if l.startswith('# ')), '')
    h1_venue = re.split(r'[｜|—\-（(]', h1)[0].strip() if h1 else None

    docs: list[dict] = []
    for sec_heading, sec_lines in sections:
        header_lines = [l for l in top_header if l.strip()] + ([sec_heading] if sec_heading else [])
        table_lines: list[str] = []
        for l in sec_lines:
            if l.strip().startswith('|'):
                table_lines.append(l)
            elif l.strip():
                header_lines.append(l.strip())

        meta = parse_header_metadata(header_lines)
        if not meta.get('venue') and h1_venue:
            meta['venue'] = h1_venue

        col_idx: dict[str, int] = {}
        parsed_rows: list[dict] = []
        for tl in table_lines:
            cells = [c.strip() for c in tl.strip().strip('|').split('|')]
            if all(re.fullmatch(r':?-{2,}:?', c) for c in cells if c):
                continue
            if not col_idx:
                mapped_hdr = {}
                for i, c in enumerate(cells):
                    ck = _identify_column_key(c)
                    if ck:
                        mapped_hdr[ck] = i
                if {'rank', 'name', 'team'}.issubset(mapped_hdr):
                    col_idx = mapped_hdr
                    continue
            if not col_idx:
                continue

            def _cell(key: str) -> str:
                i = col_idx.get(key)
                return cells[i].strip() if i is not None and i < len(cells) else ''

            name_zh = re.sub(r'\s+', '', _cell('name'))
            team = _cell('team')
            if not name_zh:
                continue
            rank_raw = _cell('rank')
            rank = int(rank_raw) if re.fullmatch(r'\d+', rank_raw) else None
            pts_raw = _cell('points').replace(',', '')
            pts: int | float | None = None
            if re.fullmatch(r'\d+(?:\.\d+)?', pts_raw):
                pts = float(pts_raw) if '.' in pts_raw else int(pts_raw)
            parsed_rows.append(
                {
                    'rank': rank,
                    'bib': _cell('bib'),
                    'name_zh': name_zh,
                    'team': team,
                    'points': pts,
                    'notes': _cell('notes'),
                }
            )

        is_cum = detect_is_cumulative(parsed_rows)
        included = True
        if allowed_divisions is not None and meta['division'] not in allowed_divisions:
            included = False
        docs.append(
            {
                'source_file': f'{md_path.name}#{sec_heading}' if sec_heading else str(md_path.name),
                'metadata': meta,
                'included_by_division_filter': included,
                'is_cumulative': is_cum,
                'row_count': len(parsed_rows),
                'rows': parsed_rows,
            }
        )
    return docs


def ingest_domestic_pdfs(
    input_paths: list[Path],
    *,
    rules_path: Path = DEFAULT_RULES_PATH,
    mapping_path: Path = DEFAULT_MAPPING_PATH,
    csv_override_path: Path | None = None,
    out_path: Path = DEFAULT_OUT_PATH,
) -> dict:
    """Parse, filter, disambiguate and persist domestic PDF and/or Markdown results."""
    rules = load_yaml(rules_path)
    mapping = load_yaml(mapping_path)
    allowed_divs = set((rules.get('roster_model') or {}).get('domestic_default_divisions') or ['甲组'])

    all_records: list[dict] = []
    all_warnings: list[dict] = []
    documents: list[dict] = []

    for input_path in sorted(input_paths):
        if input_path.suffix.lower() == '.md':
            docs = parse_domestic_markdown(input_path, allowed_divisions=allowed_divs)
        else:
            docs = [parse_domestic_pdf(input_path, allowed_divisions=allowed_divs)]
        for doc in docs:
            documents.append(
                {
                    'source_file': doc['source_file'],
                    'metadata': doc['metadata'],
                    'included_by_division_filter': doc['included_by_division_filter'],
                    'is_cumulative': doc['is_cumulative'],
                    'row_count': doc['row_count'],
                }
            )
            if not doc['included_by_division_filter']:
                continue
            resolved, warnings = disambiguate_domestic_rows(doc, mapping)
            all_records.extend(resolved)
            all_warnings.extend(warnings)

    overrides_applied = 0
    if csv_override_path and csv_override_path.exists():
        overrides_applied = apply_csv_overrides(all_records, csv_override_path)

    payload = {
        'schema_version': 1,
        'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        'allowed_divisions': sorted(allowed_divs),
        'document_count': len(documents),
        'record_count': len(all_records),
        'warning_count': len(all_warnings),
        'csv_overrides_applied': overrides_applied,
        'documents': documents,
        'warnings': all_warnings,
        'records': all_records,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='*', type=Path, help='PDF/MD files or directories containing domestic results')
    parser.add_argument('--rules', type=Path, default=DEFAULT_RULES_PATH)
    parser.add_argument('--mapping', type=Path, default=DEFAULT_MAPPING_PATH)
    parser.add_argument('--csv-overrides', type=Path, default=None)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT_PATH)
    args = parser.parse_args()

    input_files: list[Path] = []
    for p in args.inputs:
        if p.is_dir():
            input_files.extend(sorted(list(p.glob('*.pdf')) + list(p.glob('*.md'))))
        elif p.is_file():
            input_files.append(p)

    payload = ingest_domestic_pdfs(
        input_files,
        rules_path=args.rules,
        mapping_path=args.mapping,
        csv_override_path=args.csv_overrides,
        out_path=args.out,
    )
    print(
        f'Ingested {payload["document_count"]} sections -> {payload["record_count"]} records, '
        f'{payload["warning_count"]} disambiguation warnings -> {args.out}'
    )
    for w in payload['warnings'][:20]:
        print(f'  [WARN] {w["kind"]}: {w["name_zh"]} ({w["team"]}) -> {w["assigned_temp_id"]}')


if __name__ == '__main__':
    main()
