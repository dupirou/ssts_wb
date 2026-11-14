"""Chinese display names for the published site.

`data/` keeps ISU's own spelling, and every sync, identity match and statistic runs on it.
Only the files written to `dist/data` are rewritten, as the last step before they are published:
Chinese-team skaters listed in `data/athlete_names_zh.json` get their Chinese name, and relay
teams get the Chinese country name. The official spelling stays beside it (`name_latin`, or the
person's `aliases`), so search and sorting keep working.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAMES = ROOT / 'data/athlete_names_zh.json'
TEAMS = dict(
    AUS='澳大利亚', AUT='奥地利', BEL='比利时', BRA='巴西', BUL='保加利亚', CAN='加拿大', CHN='中国',
    CRO='克罗地亚', CZE='捷克', ESP='西班牙', FRA='法国', GBR='英国', GER='德国', HKG='中国香港',
    HUN='匈牙利', INA='印度尼西亚', IND='印度', ISR='以色列', ITA='意大利', JPN='日本', KAZ='哈萨克斯坦',
    KOR='韩国', LAT='拉脱维亚', LTU='立陶宛', MGL='蒙古', NED='荷兰', NOR='挪威', NZL='新西兰',
    PHI='菲律宾', POL='波兰', SGP='新加坡', SLO='斯洛文尼亚', SRB='塞尔维亚', SUI='瑞士', SVK='斯洛伐克',
    THA='泰国', TPE='中华台北', TUR='土耳其', UKR='乌克兰', USA='美国',
)  # fmt: skip
# Keys whose text must stay as ISU wrote it.
KEPT = {'aliases', 'name_latin', 'id', 'athlete_id', 'source_url', 'source_urls', 'url'}


def load(path=NAMES):
    stored = json.loads(path.read_text(encoding='utf-8'))
    if stored.get('schema_version') != 1 or not isinstance(stored.get('names'), dict):
        raise ValueError('Unsupported Chinese name table')
    return stored['country'], stored['names']


def spellings(name):
    """'Kerui SONG' as ISU's different sources write it: 'SONG Kerui', 'SONG KERUI', 'KERUI SONG'."""
    parts = name.split()
    surname = [p for p in parts if p.isupper()]
    given = [p for p in parts if not p.isupper()]
    if not surname or not given:
        return {name}
    s, g = ' '.join(surname), ' '.join(given)
    return {f'{g} {s}', f'{s} {g}', f'{s} {g.upper()}', f'{g.upper()} {s}'}


class Localizer:
    def __init__(self, country, names):
        self.country = country
        self.exact = {spelling: zh for name, zh in names.items() for spelling in spellings(name)}
        # Inside sentences (update notices) only the display spelling occurs.
        display = sorted(names, key=len, reverse=True)
        self.inline = (
            re.compile(r"(?<![\w'-])(" + '|'.join(map(re.escape, display)) + r")(?![\w'-])") if display else None
        )
        self.names = names

    def text(self, value):
        if value in self.exact:
            return self.exact[value]
        return self.inline.sub(lambda m: self.names[m[1]], value) if self.inline else value

    def walk(self, node, relay=False):
        if isinstance(node, list):
            return [self.walk(item, relay) for item in node]
        if isinstance(node, str):
            return self.text(node)
        if not isinstance(node, dict):
            return node
        relay = relay or node.get('format') == 'relay'
        result = {key: value if key in KEPT else self.walk(value, relay) for key, value in node.items()}
        name, country = node.get('name'), node.get('country')
        if not isinstance(name, str):
            return result
        if name in self.exact:
            if isinstance(country, str) and country != self.country:
                raise ValueError(f'Chinese name table matches a {country} skater: {name}')
            if isinstance(node.get('aliases'), list):
                result['aliases'] = [*node['aliases'], *([name] if name not in node['aliases'] else [])]
            else:
                result['name_latin'] = name
        elif relay and country in TEAMS and ('members' in node or 'athlete_id' not in node):
            result['name'] = TEAMS[country] + '队'
            result['name_latin'] = name
        return result


def apply(paths, table=None):
    """Rewrite the given published JSON files in place; returns how many changed."""
    localizer = Localizer(*(table or load()))
    changed = 0
    for path in paths:
        text = path.read_text(encoding='utf-8')
        data = json.loads(text)
        shown = localizer.walk(data)
        if shown != data:
            indent = 2 if text.startswith('{\n  ') or text.startswith('[\n  ') else None
            path.write_text(
                json.dumps(shown, ensure_ascii=False, indent=indent, separators=None if indent else (',', ':'))
                + ('\n' if text.endswith('\n') else ''),
                encoding='utf-8',
            )
            changed += 1
    return changed
