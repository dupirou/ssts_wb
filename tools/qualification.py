"""ISU's per-round qualification rule, as published, in short form ('2Q+6q') and in Chinese.

The text comes from the `qualification_rule` of each round in ISU's results API, e.g. 'The first and
second placed skaters from each race and up to a maximum of six fastest third place skaters qualify
for Heats.' Only the phrasings ISU uses are understood; anything else keeps its text without a short
form, so a new wording is shown as published rather than guessed at.
"""

import re

NUMBERS = dict(
    one=1, two=2, three=3, four=4, five=5, six=6, seven=7, eight=8, nine=9, ten=10,
    eleven=11, twelve=12, thirteen=13, fourteen=14, fifteen=15, sixteen=16,
)  # fmt: skip
ORDINALS = dict(first=1, second=2, third=3, fourth=4, fifth=5, sixth=6)
TARGETS = {
    'heats': '预赛',
    'quarterfinals': '1/4决赛',
    'semifinals': '半决赛',
    'rep heats': '复活赛预赛',
    'rep quarterfinals': '复活赛1/4决赛',
    'rep semifinals': '复活赛半决赛',
    'final a': 'A组决赛',
}
PLACES = r'(?:first|second|third|fourth|fifth|sixth)'
DIRECT = re.compile(rf'^the ({PLACES}(?:(?:, | and ){PLACES})*) placed (?:skaters?|teams?) from each race\b')
FASTEST = re.compile(rf'up to a maximum of (\w+) fastest ({PLACES}) place (?:skaters?|teams?)')
TARGET = re.compile(
    r'qualify for (rep\.? heats|rep\.? quarterfinals|rep\.? semifinals|heats|quarterfinals|semifinals|final a)\b'
)
RELAY_B = 'the third and fourth placed teams from each race qualify for final b'
REMAINDER_B = 'remainder may qualify for final b'


def describe(text):
    """{'code', 'zh', 'text'} for a published rule; code and zh are None when it is not understood."""
    text = ' '.join((text or '').split())
    if not text:
        return None
    low = text.lower().rstrip('.')
    unknown = dict(code=None, zh=None, text=text)
    direct, target = DIRECT.match(low), TARGET.search(low)
    if not direct or not target:
        return unknown
    places = [ORDINALS[p] for p in re.findall(PLACES, direct[1])]
    n = len(places)
    if places != list(range(1, n + 1)):
        return unknown
    fastest = FASTEST.search(low)
    q = 0
    if fastest:
        if fastest[1] not in NUMBERS or ORDINALS[fastest[2]] != n + 1:
            return unknown
        q = NUMBERS[fastest[1]]
    goal = TARGETS[target[1].replace('rep.', 'rep')]
    zh = (
        ('每组第 1 名' if n == 1 else f'每组前 {n} 名')
        + (f'及成绩最好的 {q} 名第 {n + 1} 名' if q else '')
        + f'晋级{goal}'
    )
    if RELAY_B in low:
        zh += f'，第 {n + 1}、{n + 2} 名进B组决赛'
    elif REMAINDER_B in low:
        zh += '，其余可进B组决赛'
    return dict(code=f'{n}Q' + (f'+{q}q' if q else ''), zh=zh, text=text)
