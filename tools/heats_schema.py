"""Single source of truth for heat-level historical data schemas, enums, and normalizers."""

from datetime import datetime, timezone
import re
import unicodedata
from zoneinfo import ZoneInfo

import competition_data

SCHEMA_VERSION = 1

SESSION_TYPES = ('PRELIM', 'MAIN', 'REPECHAGE')
ROUNDS = ('pre_preliminaries', 'preliminaries', 'heats', 'quarterfinal', 'semifinal', 'final')
STATUSES = ('OK', 'NO_TIME', 'PEN', 'YC', 'RC', 'DNF', 'DNS', 'ADV')
QUAL_FLAGS_RAW = ('p', 'Q', 'q', 'QA', 'qA', 'QB', 'qB', 'ADV', 'ADVA', 'ADVB')
QUAL_TYPES = ('p', 'Q', 'q', 'QB', 'qB', 'ADV', 'OUT')
QUAL_TARGETS = ('NEXT', 'FA', 'FB')

ROUND_TIERS = {
    'pre_preliminaries': -1,
    'preliminaries': 0,
    'heats': 1,
    'quarterfinal': 2,
    'semifinal': 3,
}

# Verified city -> IANA timezone mapping.
# ISU's events/list time_zone field is unreliable (e.g. Etc/UTC or America/Halifax for Montreal),
# and heat.date carries local wall-clock time mislabeled with a trailing '.000Z'.
CITY_TIMEZONES = {
    'almaty': 'Asia/Almaty',
    'beijing': 'Asia/Shanghai',
    'calgary': 'America/Edmonton',
    'debrecen': 'Europe/Budapest',
    'dordrecht': 'Europe/Amsterdam',
    'dordrech': 'Europe/Amsterdam',
    'dresden': 'Europe/Berlin',
    'gdansk': 'Europe/Warsaw',
    'laval': 'America/Toronto',
    'milan': 'Europe/Rome',
    'milano': 'Europe/Rome',
    'milano cortina': 'Europe/Rome',
    'montreal': 'America/Toronto',
    'nagoya': 'Asia/Tokyo',
    'rotterdam': 'Europe/Amsterdam',
    'salt lake city': 'America/Denver',
    'seoul': 'Asia/Seoul',
    'shanghai': 'Asia/Shanghai',
    'tilburg': 'Europe/Amsterdam',
    'torino': 'Europe/Rome',
    'vancouver': 'America/Vancouver',
}

# Cyrillic and Greek lookalike characters that appear in manual/PDF skater names.
CONFUSABLES = str.maketrans(
    {
        'А': 'A',
        'В': 'B',
        'Е': 'E',
        'К': 'K',
        'М': 'M',
        'Н': 'H',
        'О': 'O',
        'Р': 'P',
        'С': 'C',
        'Т': 'T',
        'У': 'Y',
        'Х': 'X',
        'І': 'I',
        'а': 'a',
        'е': 'e',
        'і': 'i',
        'о': 'o',
        'р': 'p',
        'с': 'c',
        'у': 'y',
        'х': 'x',
        'Α': 'A',
        'Β': 'B',
        'Ε': 'E',
        'Ζ': 'Z',
        'Η': 'H',
        'Ι': 'I',
        'Κ': 'K',
        'Μ': 'M',
        'Ν': 'N',
        'Ο': 'O',
        'Ρ': 'P',
        'Τ': 'T',
        'Χ': 'X',
        'Ł': 'L',
        'ł': 'l',
        'Ø': 'O',
        'ø': 'o',
        'Đ': 'D',
        'đ': 'd',
        'ß': 'ss',
        'Æ': 'AE',
        'æ': 'ae',
        'Œ': 'OE',
        'œ': 'oe',
    }
)

TIME_RE = re.compile(r'^(?:(\d+):)?(\d{1,2})\.(\d{3})$')


def plain_text(text):
    """Strip diacritics and normalize Unicode/confusables while keeping case."""
    text = unicodedata.normalize('NFKC', text or '').translate(CONFUSABLES)
    return ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c))


def normalize_name_key(name):
    """Order- and diacritic-insensitive token key for athlete identity matching."""
    cleaned = plain_text(name).casefold()
    tokens = sorted(re.findall(r'[a-z0-9]+', cleaned))
    return tuple(tokens)


def normalize_city(city):
    """Extract base city name and fold accents/case for timezone lookup."""
    base = (city or '').split(',')[0].strip()
    return plain_text(base).casefold()


def event_timezone(city):
    key = normalize_city(city)
    if key not in CITY_TIMEZONES:
        raise ValueError(f'Unknown event city for timezone lookup: {city!r}')
    return ZoneInfo(CITY_TIMEZONES[key])


def local_wallclock_to_utc(raw_timestamp, city):
    """Convert ISU API pseudo-UTC local timestamp ('...T09:30:11.000Z') to actual UTC ISO string."""
    if not raw_timestamp:
        return None
    text = raw_timestamp.strip()
    if text.endswith('Z'):
        text = text[:-1]
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    local_dt = dt.replace(tzinfo=event_timezone(city))
    utc_dt = local_dt.astimezone(timezone.utc)
    return utc_dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def legacy_athlete_id(name, country, gender):
    return competition_data.athlete_id(name, country, gender)


def parse_distance_instance(name, fallback=1):
    match = re.search(r'\((\d+)\)\s*$', name or '')
    return int(match[1]) if match else fallback


def parse_round_name(raw_name):
    """Map an official round label to (session_type, round_enum, base_round_tier)."""
    label = re.sub(r'\s+', ' ', (raw_name or '')).strip()
    low = label.lower()
    is_rep = bool(re.match(r'^rep(?:echage)?\.?\s+', low))
    core = re.sub(r'^rep(?:echage)?\.?\s+', '', low)
    if re.fullmatch(r'pre[- ]?preliminaries', core):
        round_enum = 'pre_preliminaries'
    elif re.fullmatch(r'preliminaries', core):
        round_enum = 'preliminaries'
    elif re.fullmatch(r'heats', core):
        round_enum = 'heats'
    elif re.fullmatch(r'quarter[- ]?finals?', core):
        round_enum = 'quarterfinal'
    elif re.fullmatch(r'semi[- ]?finals?', core):
        round_enum = 'semifinal'
    elif not is_rep and re.fullmatch(r'finals?(?:\s+[ab])?', core):
        round_enum = 'final'
    else:
        raise ValueError(f'Unsupported official round name: {raw_name!r}')
    session_type = (
        'REPECHAGE'
        if is_rep
        else ('PRELIM' if round_enum in ('pre_preliminaries', 'preliminaries', 'heats') else 'MAIN')
    )
    tier = ROUND_TIERS.get(round_enum, 5)
    return session_type, round_enum, tier


def parse_heat_label(label, round_enum):
    """Extract (heat_number, final_group) from an official heat label."""
    text = re.sub(r'\s+', ' ', (label or '')).strip()
    if round_enum == 'final':
        m = re.fullmatch(r'Final(?:\s+([AB]))?', text, re.I)
        if m:
            return None, (m[1] or 'A').upper()
    m = re.fullmatch(r'(?:Heat|Quarterfinal|Semifinal)\s+(\d+)', text, re.I)
    if m:
        return int(m[1]), None
    raise ValueError(f'Unsupported heat label {label!r} for round {round_enum!r}')


def parse_time_seconds(value):
    """Parse 'SS.mmm' or 'M:SS.mmm' to float seconds, or return None."""
    if value is None:
        return None
    m = TIME_RE.fullmatch(str(value).strip())
    if not m:
        return None
    mins = int(m[1]) if m[1] else 0
    secs = int(m[2])
    ms = int(m[3])
    return round(mins * 60 + secs + ms / 1000.0, 3)


def normalize_qual_flag_raw(raw_flag):
    """Normalize minor casing variants of ADV while preserving Q vs q and QB vs qB."""
    text = (raw_flag or '').strip()
    if not text:
        return None
    if text == 'ADVa':
        return 'ADVA'
    if text == 'ADVb':
        return 'ADVB'
    if text not in QUAL_FLAGS_RAW:
        raise ValueError(f'Unknown official qualification flag: {raw_flag!r}')
    return text


def normalize_qualification(raw_flag, session_type, round_enum):
    """Return (qual_flag_raw, qual_type, qual_target, advanced) per D0 rules."""
    flag = normalize_qual_flag_raw(raw_flag)
    if round_enum == 'final':
        if flag is not None:
            raise ValueError(f'Unexpected qualification flag {flag!r} in final round')
        return None, None, None, None
    if flag == 'p':
        return flag, 'p', None, None
    if flag is None:
        return None, 'OUT', None, False
    is_main_sf = session_type == 'MAIN' and round_enum == 'semifinal'
    if is_main_sf:
        mapping = {
            'QA': ('Q', 'FA', True),
            'Q': ('Q', 'FA', True),
            'qA': ('q', 'FA', True),
            'q': ('q', 'FA', True),
            'ADVA': ('ADV', 'FA', True),
            'ADV': ('ADV', 'FA', True),
            'QB': ('QB', 'FB', False),
            'qB': ('qB', 'FB', False),
            'ADVB': ('ADV', 'FB', False),
        }
        if flag not in mapping:
            raise ValueError(f'Unexpected semifinal qualification flag: {flag!r}')
        qtype, qtarget, adv = mapping[flag]
        return flag, qtype, qtarget, adv
    mapping = {
        'Q': ('Q', 'NEXT', True),
        'q': ('q', 'NEXT', True),
        'ADV': ('ADV', 'NEXT', True),
    }
    if flag not in mapping:
        raise ValueError(f'Unexpected non-SF qualification flag {flag!r} in {session_type}/{round_enum}')
    qtype, qtarget, adv = mapping[flag]
    return flag, qtype, qtarget, adv


def normalize_status(raw_result, raw_result_status, qual_flag_raw):
    """Return (status, time_s, penalty, is_incident, incident_type) failing closed on unknown values."""
    res = (raw_result or '').strip()
    rstatus = (raw_result_status or '').strip()
    time_s = parse_time_seconds(res)

    # Check explicit non-racing statuses first.
    res_low = res.lower()
    if res in ('PEN', 'P', 'DSQ', 'DQ') or rstatus in ('Penalty', 'DisQualified'):
        if qual_flag_raw is not None:
            raise ValueError(f'Penalized skater has qualification flag: {qual_flag_raw!r}')
        return 'PEN', None, 'PEN', True, 'PEN'
    if res.startswith('YC') or rstatus == 'Yellow Card':
        pen = res if res.startswith('YC') else 'YC'
        return 'YC', None, pen, True, 'PEN'
    if res.startswith('RC') or rstatus == 'Red Card':
        pen = res if res.startswith('RC') else 'RC'
        return 'RC', None, pen, True, 'PEN'
    if res == 'DNF' or rstatus == 'Did Not Finish':
        return 'DNF', None, None, True, 'DNF'
    if res == 'DNS' or rstatus == 'Did Not Start':
        return 'DNS', None, None, False, None

    if qual_flag_raw in ('ADV', 'ADVA', 'ADVB'):
        if time_s is None and res_low not in ('no time', 'nt', ''):
            raise ValueError(f'Unexpected ADV final_result: {raw_result!r} ({raw_result_status!r})')
        return 'ADV', time_s, None, False, None

    if time_s is not None:
        if rstatus not in ('', 'Official', 'Finished'):
            raise ValueError(f'Unexpected result_status with timed finish: {rstatus!r}')
        return 'OK', time_s, None, False, None

    if res_low in ('no time', 'nt'):
        if rstatus not in ('', 'Official', 'Finished Without Time'):
            raise ValueError(f'Unexpected result_status with no time: {rstatus!r}')
        return 'NO_TIME', None, None, False, None

    raise ValueError(
        f'Unknown official result/status: final_result={raw_result!r}, result_status={raw_result_status!r}'
    )


def extract_laps(lap_rows):
    """Extract (opening_split_s, lap_times_s) from ISU API competitor 'lap' array."""
    if not lap_rows:
        return None, None
    ordered = sorted(lap_rows, key=lambda item: int(item['LapNumber']))
    times = []
    for item in ordered:
        t = parse_time_seconds(item.get('LapTime'))
        if t is None:
            return None, None
        times.append(t)
    if not times:
        return None, None
    return times[0], times


def is_withdrawn_ghost(comp):
    """Detect withdrawn/start-list ghost rows that carry no rank, time, status, qual, or laps."""
    return (
        comp.get('final_rank') in (None, '')
        and str(comp.get('final_result') or '').strip().lower() in ('', 'no time')
        and not (comp.get('result_status') or '').strip()
        and not (comp.get('qualification_code') or '').strip()
        and not comp.get('lap')
    )


def live_athlete_id(part, mappings, official_ids):
    mapped = mappings.get(part.get('athlete_id'))
    if mapped:
        return mapped['athlete_id']
    oid = part.get('official_skater_id')
    if isinstance(oid, int) and oid > 0:
        return official_ids.get(oid, f'skr-{oid}')
    return part.get('athlete_id')
