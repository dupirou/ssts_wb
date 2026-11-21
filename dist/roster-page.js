/* Roster & ISU Quota view: lazy-loaded only on /roster/. Pure vanilla JS, zero dependencies. */
(function () {
  'use strict';
  const site = (window.SSTS = window.SSTS || {});

  const COUNTRY_NAMES = {
    AIN: '中立个人',
    AIN2: '中立个人(2)',
    AUS: '澳大利亚',
    AUT: '奥地利',
    BEL: '比利时',
    BRA: '巴西',
    BUL: '保加利亚',
    CAN: '加拿大',
    CHN: '中国',
    CRO: '克罗地亚',
    CZE: '捷克',
    ESP: '西班牙',
    FRA: '法国',
    GBR: '英国',
    GER: '德国',
    HKG: '中国香港',
    HUN: '匈牙利',
    INA: '印度尼西亚',
    IND: '印度',
    ISR: '以色列',
    ITA: '意大利',
    JPN: '日本',
    KAZ: '哈萨克斯坦',
    KOR: '韩国',
    LAT: '拉脱维亚',
    LTU: '立陶宛',
    MGL: '蒙古',
    NED: '荷兰',
    NOR: '挪威',
    NZL: '新西兰',
    PHI: '菲律宾',
    POL: '波兰',
    SGP: '新加坡',
    SLO: '斯洛文尼亚',
    SRB: '塞尔维亚',
    SUI: '瑞士',
    SVK: '斯洛伐克',
    THA: '泰国',
    TPE: '中华台北',
    TUR: '土耳其',
    UKR: '乌克兰',
    USA: '美国'
  };

  const SOURCE_LABELS = {
    Senior: '成年世巡',
    JWC: '青杯',
    Domestic: '国内甲组'
  };

  const ROLE_LABELS = {
    sprint_relay: '短距离 / 接力',
    mid_long: '中长距离',
    versatile_upside: '综合 / 高潜力机动'
  };

  const DIST_KEYS = ['500', '1000', '1500', 'relay'];
  const DIST_LABELS = { 500: '500m', 1000: '1000m', 1500: '1500m', relay: '接力' };

  const pct = (v, digits = 1) => ((Number(v) || 0) * 100).toFixed(digits) + '%';
  const fmtSigned = (v, digits = 2) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const fixed = n.toFixed(digits);
    return n > 0 ? '+' + fixed : fixed;
  };
  const countryLabel = (code) => (COUNTRY_NAMES[code] ? `${COUNTRY_NAMES[code]} ${code}` : code);
  const normNameKey = (name) =>
    String(name || '')
      .toUpperCase()
      .replace(/[^A-Z]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .sort()
      .join('|');

  function buildAthleteLookup(forecast) {
    const byId = new Map();
    const byNameKey = new Map();
    const ingest = (list) => {
      for (const item of list || []) {
        if (!item) continue;
        const prev = byId.get(item.athlete_id) || {};
        const merged = {
          ...prev,
          ...item,
          name_zh: item.name_zh || prev.name_zh || null,
          name_en: item.name_en || prev.name_en || null
        };
        if (item.athlete_id) byId.set(item.athlete_id, merged);
        if (merged.name_en) byNameKey.set(normNameKey(merged.name_en), merged);
      }
    };
    for (const scenario of Object.values(forecast?.scenarios || {})) {
      for (const gender of ['women', 'men']) {
        ingest(scenario?.[gender]?.candidates);
        ingest(scenario?.[gender]?.reserves);
      }
    }
    return { byId, byNameKey };
  }

  function displayName(item, lookup) {
    if (!item) return { zh: '未知选手', en: '' };
    const found =
      (item.athlete_id && lookup?.byId.get(item.athlete_id)) ||
      (item.name && lookup?.byNameKey.get(normNameKey(item.name))) ||
      (item.name_en && lookup?.byNameKey.get(normNameKey(item.name_en)));
    const zh = item.name_zh || found?.name_zh || null;
    const en = item.name_en || item.name || found?.name_en || '';
    return {
      zh: zh || en || item.athlete_id || '未知选手',
      en: zh && en && zh !== en ? en : ''
    };
  }

  function shortName(id, lookup) {
    const item = lookup.byId.get(id);
    if (!item) return id;
    return item.name_zh || item.name_en || id;
  }

  function topRankedDistance(worldRanks) {
    let bestDist = null;
    let bestRank = Infinity;
    for (const [dist, rank] of Object.entries(worldRanks || {})) {
      if (Number.isFinite(rank) && rank < bestRank) {
        bestRank = rank;
        bestDist = dist;
      }
    }
    return bestDist ? { dist: bestDist, rank: bestRank } : null;
  }

  function skillSummary(candidate) {
    const skills = candidate.skills || candidate.distances || candidate.mu_sigma;
    if (skills && typeof skills === 'object') {
      let best = null;
      for (const d of ['500', '1000', '1500']) {
        const entry = skills[d] || skills[Number(d)];
        if (entry && Number.isFinite(entry.mu)) {
          const cons = entry.mu - 2 * (Number.isFinite(entry.sigma) ? entry.sigma : 0);
          if (!best || cons > best.cons) {
            best = {
              dist: d,
              mu: entry.mu,
              sigma: Number.isFinite(entry.sigma) ? entry.sigma : null,
              cons
            };
          }
        }
      }
      if (best) {
        return {
          label: `${best.dist}m μ ± σ`,
          text:
            best.sigma != null
              ? `${best.mu.toFixed(2)} ± ${best.sigma.toFixed(2)}`
              : best.mu.toFixed(2),
          detail: ['500', '1000', '1500']
            .map((d) => {
              const e = skills[d] || skills[Number(d)];
              return e && Number.isFinite(e.mu)
                ? `${d}m ${e.mu.toFixed(2)}±${(e.sigma ?? 0).toFixed(2)}`
                : null;
            })
            .filter(Boolean)
            .join(' · ')
        };
      }
    }
    if (Number.isFinite(candidate.mu)) {
      return {
        label: '实力 μ ± σ',
        text:
          candidate.sigma != null
            ? `${candidate.mu.toFixed(2)} ± ${candidate.sigma.toFixed(2)}`
            : candidate.mu.toFixed(2),
        detail: ''
      };
    }
    const vs = candidate.value_scores || {};
    const peak = Math.max(vs[500] || 0, vs[1000] || 0, vs[1500] || 0);
    return {
      label: '峰值评分',
      text: peak > 0 ? peak.toFixed(2) : '—',
      detail: `500m ${(vs[500] || 0).toFixed(2)} · 1000m ${(vs[1000] || 0).toFixed(2)} · 1500m ${(vs[1500] || 0).toFixed(2)}`
    };
  }

  function renderQuotaSection(h, quotas, forecast, state, lookup) {
    const { event, gender } = state;
    const isWt = event === 'wt';
    const genderLabel = gender === 'women' ? '女子' : '男子';
    const wcAll = quotas.world_championships_2027 || {};
    const wcRelays = wcAll.relays || {};
    const genderRelayKey = gender === 'women' ? 'women_3000m' : 'men_5000m';
    const genderRelayLabel = gender === 'women' ? '女子 3000m 接力' : '男子 5000m 接力';
    const genderRelayChn = (wcRelays[genderRelayKey]?.standings || []).find(
      (s) => s.country === 'CHN'
    );
    const mixedRelayChn = (wcRelays.mixed_2000m?.standings || []).find((s) => s.country === 'CHN');

    const wtChn = quotas.world_tour_2026_27?.quotas?.[gender]?.CHN || {};
    const wcChn = wcAll.individual_and_roster?.[gender]?.CHN || {};
    const chnQuota = isWt ? wtChn : wcChn;

    const fourSet = new Set(wtChn.four_skater_distances || []);
    const upgradedSet = new Set(wcChn.host_upgraded_distances || []);
    const distCards = ['500m', '1000m', '1500m'].map((dist) => {
      const slots = chnQuota['slots_' + dist] ?? '—';
      let note;
      if (isWt) {
        const top40 = wtChn.top40_counts?.[dist];
        note = fourSet.has(dist)
          ? `WT Top-40 报 4 人特例${top40 != null ? `（Top-40 ${top40} 人）` : ''}`
          : '常规 3 人上限';
      } else {
        note = upgradedSet.has(dist) ? 'Comm. 2805（东道主补足）' : 'Comm. 2805 核定席位';
      }
      return h(
        'div',
        { class: 'roster-quota-chip' },
        h('span', { class: 'roster-quota-label', text: `${dist} 席位` }),
        h('b', { class: 'roster-quota-val num', text: `${slots} 人` }),
        h('small', { class: 'roster-quota-sub', text: note })
      );
    });

    const relayText = (row, label) => {
      if (!row) return `${label}：暂无排名`;
      const qual = row.qualified ? '已获资格' : '未获资格';
      return `${label}：第 ${row.official_rank} 名 · ${row.points} 分 · ${qual}`;
    };

    const quotaGrid = h(
      'div',
      { class: 'roster-quota-grid' },
      h(
        'div',
        { class: 'roster-quota-chip is-accent' },
        h('span', { class: 'roster-quota-label', text: `${genderLabel}总注册上限` }),
        h('b', { class: 'roster-quota-val num', text: `${chnQuota.max_roster_size ?? '—'} 人` }),
        h('small', {
          class: 'roster-quota-sub',
          text: isWt ? '2026/27 世巡赛单站上限' : '2027 首尔世锦赛 Comm. 2805'
        })
      ),
      ...distCards,
      h(
        'div',
        { class: 'roster-quota-chip is-relay' },
        h('span', { class: 'roster-quota-label', text: '接力资格状态' }),
        h('p', {
          class: 'roster-relay-line',
          text: relayText(genderRelayChn, genderRelayLabel)
        }),
        h('p', {
          class: 'roster-relay-line',
          text: relayText(mixedRelayChn, '混合 2000m 接力')
        })
      )
    );

    // Penalty warnings & bans bar
    const chnBans = forecast.penalty_bans_applied || [];
    const chnWarnings = forecast.penalty_warnings_chn || [];
    const allBans =
      forecast.penalty_bans_all_members || quotas.world_tour_2026_27?.next_stop_penalty_bans || [];
    const allWarnings = quotas.world_tour_2026_27?.one_away_from_ban_warnings || [];

    const penaltyBar = h(
      'div',
      { class: 'roster-penalty-bar', 'aria-label': '累计犯规禁报预警' },
      h(
        'div',
        { class: 'roster-penalty-head' },
        h(
          'span',
          {
            class: `roster-status-pill ${chnBans.length ? 'is-danger' : 'is-safe'}`
          },
          chnBans.length
            ? `中国队触发禁报 ${chnBans.length} 人`
            : '中国队当前 0 人触发 3/5/7 次禁报'
        ),
        h(
          'span',
          { class: 'roster-status-pill is-warn' },
          `中国队 2 次犯规预警 ${chnWarnings.length} 人`
        ),
        h(
          'span',
          { class: 'roster-penalty-global faint' },
          `全联盟已禁报 ${allBans.length} 人 · 2 次预警 ${allWarnings.length} 人`
        )
      ),
      chnBans.length || chnWarnings.length
        ? h(
            'ul',
            { class: 'roster-penalty-list' },
            ...chnBans.map((b) => {
              const nm = displayName(b, lookup);
              return h(
                'li',
                { class: 'roster-penalty-item is-danger' },
                h('b', { text: nm.zh }),
                nm.en ? h('span', { class: 'faint', text: nm.en }) : null,
                h('span', {
                  class: 'roster-tag',
                  text: b.gender === 'women' ? '女子' : '男子'
                }),
                h('span', {
                  class: 'num',
                  text: `累计 ${b.cumulative_penalties} 次 · 禁报 ${(b.blocked_distances || []).join(' / ')}`
                })
              );
            }),
            ...chnWarnings.map((w) => {
              const nm = displayName(w, lookup);
              const top = topRankedDistance(w.world_ranks);
              return h(
                'li',
                { class: 'roster-penalty-item is-warn' },
                h('b', { text: nm.zh }),
                nm.en ? h('span', { class: 'faint', text: nm.en }) : null,
                h('span', {
                  class: 'roster-tag',
                  text: w.gender === 'women' ? '女子' : '男子'
                }),
                h('span', {
                  class: 'num',
                  text: `累计 ${w.cumulative_penalties} 次犯规${
                    top ? ` · 再犯禁报最高排名单项 ${top.dist} (#${top.rank})` : ''
                  }`
                })
              );
            })
          )
        : null,
      allBans.length
        ? h(
            'p',
            { class: 'roster-penalty-note faint' },
            '全联盟禁报参考：' +
              allBans
                .map(
                  (b) =>
                    `${b.country} ${b.name}（${b.cumulative_penalties} 次 · 禁报 ${(b.blocked_distances || []).join('/')}）`
                )
                .join('；')
          )
        : null
    );

    // Collapsible 2027 WC all-countries quota & relay table
    const wcGenderTable = wcAll.individual_and_roster?.[gender] || {};
    const genderRelayMap = new Map(
      (wcRelays[genderRelayKey]?.standings || []).map((s) => [s.country, s])
    );
    const mixedRelayMap = new Map(
      (wcRelays.mixed_2000m?.standings || []).map((s) => [s.country, s])
    );

    const rowsData = Object.values(wcGenderTable).sort((a, b) => {
      if (a.country === 'CHN') return -1;
      if (b.country === 'CHN') return 1;
      return (
        (b.max_roster_size || 0) - (a.max_roster_size || 0) ||
        b.slots_500m +
          b.slots_1000m +
          b.slots_1500m -
          (a.slots_500m + a.slots_1000m + a.slots_1500m) ||
        a.country.localeCompare(b.country)
      );
    });

    const filterInput = h('input', {
      type: 'search',
      class: 'roster-country-filter',
      placeholder: '筛选国家代码或中文名（如 CHN / KOR / 中国）',
      'aria-label': '筛选国家或地区'
    });
    const tbody = h('tbody');
    const tableCount = h('span', { class: 'faint tiny', role: 'status' });

    const renderCountryRows = () => {
      const q = filterInput.value.trim().toUpperCase();
      const filtered = rowsData.filter((r) => {
        if (!q) return true;
        const zh = (COUNTRY_NAMES[r.country] || '').toUpperCase();
        return r.country.toUpperCase().includes(q) || zh.includes(q);
      });
      tableCount.textContent = `显示 ${filtered.length} / ${rowsData.length} 个国家/地区`;
      tbody.replaceChildren(
        ...filtered.map((r) => {
          const gr = genderRelayMap.get(r.country);
          const mr = mixedRelayMap.get(r.country);
          const relayCell = (rec, hasFlag) => {
            if (!hasFlag && !rec?.qualified) {
              return rec ? `未入围 (#${rec.official_rank})` : '—';
            }
            return rec ? `✓ #${rec.official_rank} (${rec.points}分)` : '✓ 已获资格';
          };
          return h(
            'tr',
            { class: r.country === 'CHN' ? 'is-chn' : null },
            h(
              'td',
              {},
              h(
                'span',
                { class: r.country === 'CHN' ? 'athlete-china' : 'roster-noc' },
                countryLabel(r.country)
              )
            ),
            h('td', { class: 'num', text: String(r.slots_500m) }),
            h('td', { class: 'num', text: String(r.slots_1000m) }),
            h('td', { class: 'num', text: String(r.slots_1500m) }),
            h('td', { class: 'num', text: relayCell(gr, r.has_gender_relay) }),
            h('td', { class: 'num', text: relayCell(mr, r.has_mixed_relay) }),
            h('td', { class: 'num', text: `${r.max_roster_size} 人` })
          );
        })
      );
    };
    filterInput.addEventListener('input', renderCountryRows);
    renderCountryRows();

    const countriesDetails = h(
      'details',
      { class: 'roster-countries-panel' },
      h('summary', {}, `各国 2027 世锦赛名额与接力榜（${genderLabel} · ${rowsData.length} 队）`),
      h('div', { class: 'roster-countries-tools' }, filterInput, tableCount),
      site.ui.tableScroll(
        h,
        h(
          'table',
          { class: 'roster-countries-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { text: '国家 / 地区' }),
              h('th', { text: '500m' }),
              h('th', { text: '1000m' }),
              h('th', { text: '1500m' }),
              h('th', { text: genderLabel + '接力' }),
              h('th', { text: '混合接力' }),
              h('th', { text: '总上限' })
            )
          ),
          tbody
        ),
        '各国 2027 世锦赛名额与接力榜'
      )
    );

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '名额与规则看板' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: '名额与规则看板' }),
        h('p', {
          text: isWt
            ? `下一站：${forecast.next_wt_stop?.city || 'Shanghai'} (${forecast.next_wt_stop?.date_start || ''})`
            : '依据 ISU Communication 2805 核定'
        })
      ),
      quotaGrid,
      penaltyBar,
      countriesDetails
    );
  }

  function renderCandidateCard(h, candidate, preferredEntries, lookup, isMain) {
    const nm = displayName(candidate, lookup);
    const isDual = candidate.is_dual_eligible === true || candidate.age_group === 'DUAL_ELIGIBLE';
    const ageLabel =
      candidate.is_dual_eligible != null || candidate.age_group
        ? isDual
          ? '双适龄 U-19'
          : '成年'
        : null;
    const sources = (candidate.data_sources || []).map((s) => SOURCE_LABELS[s] || s);
    const preferredDists = DIST_KEYS.filter((d) =>
      (preferredEntries?.[d] || []).includes(candidate.athlete_id)
    );
    const skill = skillSummary(candidate);
    const momentum = candidate.form_momentum ?? candidate.value_scores?.form;
    const momNum = Number(momentum);
    const momClass = !Number.isFinite(momNum)
      ? ''
      : momNum > 0
        ? 'is-pos'
        : momNum < 0
          ? 'is-neg'
          : '';

    const bars = DIST_KEYS.map((d) => {
      const p = candidate.entry_prob_matrix?.[d] ?? 0;
      const isPref = preferredDists.includes(d);
      return h(
        'div',
        { class: `roster-prob-row${isPref ? ' is-preferred' : ''}` },
        h(
          'span',
          { class: 'roster-prob-dist' },
          DIST_LABELS[d],
          isPref
            ? h('i', { class: 'roster-pref-dot', title: '首选报项', 'aria-label': '首选' })
            : null
        ),
        h(
          'div',
          { class: 'roster-prob-track', 'aria-hidden': 'true' },
          h('div', {
            class: 'roster-prob-fill',
            style: { width: Math.min(100, Math.max(0, p * 100)).toFixed(1) + '%' }
          })
        ),
        h('span', { class: 'roster-prob-val num', text: pct(p, 0) })
      );
    });

    return h(
      'article',
      {
        class: `roster-skater-card${isMain ? ' is-main' : ''}`,
        dataset: { athleteId: candidate.athlete_id }
      },
      h(
        'div',
        { class: 'roster-skater-head' },
        h(
          'div',
          { class: 'roster-skater-name' },
          h('b', { text: nm.zh }),
          nm.en ? h('small', { class: 'faint', text: nm.en }) : null
        ),
        h(
          'span',
          { class: 'roster-main-prob num' },
          '正选 ',
          h('strong', { text: pct(candidate.main_roster_prob) })
        )
      ),
      h(
        'div',
        { class: 'roster-tags' },
        ageLabel
          ? h('span', { class: `roster-tag ${isDual ? 'is-dual' : 'is-senior'}`, text: ageLabel })
          : null,
        ...sources.map((src) => h('span', { class: 'roster-tag is-source', text: src })),
        preferredDists.length
          ? h(
              'span',
              { class: 'roster-tag is-pref-summary' },
              '首选 ' + preferredDists.map((d) => DIST_LABELS[d]).join('·')
            )
          : null
      ),
      h('div', { class: 'roster-prob-matrix' }, ...bars),
      h(
        'div',
        { class: 'roster-skater-foot' },
        h(
          'div',
          { class: 'roster-metric', title: skill.detail || undefined },
          h('small', { class: 'faint', text: skill.label }),
          h('span', { class: 'num', text: skill.text })
        ),
        h(
          'div',
          { class: 'roster-metric' },
          h('small', { class: 'faint', text: '状态动量' }),
          h('span', {
            class: `roster-momentum num ${momClass}`,
            text: fmtSigned(momentum)
          })
        )
      )
    );
  }

  function renderMainSection(h, scenarioData, forecast, state, lookup) {
    const preferred = scenarioData.preferred_main_roster || { athlete_ids: [], entries: {} };
    const mainSet = new Set(preferred.athlete_ids || []);
    const candidates = scenarioData.candidates || [];
    const mainCandidates = candidates.filter((c) => mainSet.has(c.athlete_id));
    const otherCandidates = candidates.filter((c) => !mainSet.has(c.athlete_id));

    const cardsWrap = h(
      'div',
      { class: 'roster-main-grid' },
      ...mainCandidates.map((c) => renderCandidateCard(h, c, preferred.entries, lookup, true))
    );

    const allToggle =
      otherCandidates.length > 0
        ? h(
            'details',
            { class: 'roster-all-candidates' },
            h('summary', {
              text: `展开其余候选池（${otherCandidates.length} 人 · 共 ${candidates.length} 名适龄选手）`
            }),
            h(
              'div',
              { class: 'roster-main-grid' },
              ...otherCandidates.map((c) =>
                renderCandidateCard(h, c, preferred.entries, lookup, false)
              )
            )
          )
        : null;

    // Top-3 lineups
    const top3 = scenarioData.top_3_lineups || [];
    const top3Grid = h(
      'div',
      { class: 'roster-lineups-grid' },
      ...top3.map((lu, idx) =>
        h(
          'details',
          { class: 'roster-lineup-card', open: idx === 0 },
          h(
            'summary',
            { class: 'roster-lineup-head' },
            h('span', { class: 'roster-lineup-rank num', text: `方案 #${idx + 1}` }),
            idx === 0 ? h('span', { class: 'roster-tag is-pref-summary', text: '高频首选' }) : null,
            h('b', { class: 'roster-lineup-freq num', text: `出现频率 ${pct(lu.frequency)}` }),
            h('small', {
              class: 'faint num',
              text: `均值 ${Number(lu.avg_objective || 0).toFixed(2)}`
            })
          ),
          h(
            'div',
            { class: 'roster-lineup-body' },
            h(
              'div',
              { class: 'roster-lineup-members' },
              ...(lu.athlete_ids || []).map((id) =>
                h('span', { class: 'roster-member-chip', text: shortName(id, lookup) })
              )
            ),
            h(
              'dl',
              { class: 'roster-lineup-entries' },
              ...DIST_KEYS.map((d) =>
                h(
                  'div',
                  { class: 'roster-lineup-dist' },
                  h('dt', { text: DIST_LABELS[d] }),
                  h('dd', {
                    text:
                      (lu.modal_entries?.[d] || [])
                        .map((id) => shortName(id, lookup))
                        .join(' · ') || '—'
                  })
                )
              )
            )
          )
        )
      )
    );

    const excluded = forecast.excluded_by_age?.[state.gender] || [];
    const excludedNote = excluded.length
      ? h(
          'p',
          { class: 'roster-excluded-note faint' },
          `青年适龄未入成年池（${excluded.length} 人）：` +
            excluded
              .map((e) => `${e.name_zh || e.name_en}（${e.birth_date || 'U-19 青年组'}）`)
              .join('、')
        )
      : null;

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '正选大名单与报项概率矩阵' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: '中国队正选大名单与报项概率矩阵' }),
        h('p', {
          class: 'num',
          text: `正选 ${mainCandidates.length} 人 · 模拟 ${scenarioData.feasible_draws || scenarioData.draws || 1000} 次 · 不同组合 ${scenarioData.distinct_lineups || '—'} 种`
        })
      ),
      cardsWrap,
      allToggle,
      h(
        'div',
        { class: 'roster-subhead' },
        h('h3', { text: 'Top-3 最高频完整阵容方案' }),
        h('span', { class: 'faint tiny', text: '点击可折叠或展开单项分工' })
      ),
      top3Grid,
      excludedNote
    );
  }

  function renderReservesSection(h, scenarioData, lookup) {
    const reserves = [...(scenarioData.reserves || [])].sort(
      (a, b) => (a.reserve_rank || 99) - (b.reserve_rank || 99)
    );
    const counts = { sprint_relay: 0, mid_long: 0, versatile_upside: 0 };
    for (const r of reserves) {
      if (counts[r.role_tag] != null) counts[r.role_tag]++;
    }

    const summaryChips = h(
      'div',
      { class: 'roster-reserve-summary' },
      ...Object.entries(ROLE_LABELS).map(([tag, label]) =>
        h('span', { class: `roster-tag is-role-${tag}` }, `${label} ${counts[tag] || 0} 人`)
      )
    );

    const grid = h(
      'div',
      { class: 'roster-reserve-grid' },
      ...reserves.map((r) => {
        const nm = displayName(r, lookup);
        const repName = r.primary_replacement_for
          ? shortName(r.primary_replacement_for, lookup)
          : '—';
        const roleLabel = ROLE_LABELS[r.role_tag] || r.role_tag;
        const sources = (r.data_sources || []).map((s) => SOURCE_LABELS[s] || s);

        return h(
          'article',
          { class: 'roster-reserve-card', dataset: { roleTag: r.role_tag } },
          h(
            'div',
            { class: 'roster-reserve-head' },
            h('span', { class: 'roster-reserve-rank num', text: `#${r.reserve_rank}` }),
            h('span', { class: `roster-tag is-role-${r.role_tag}`, text: roleLabel }),
            h('span', {
              class: `roster-tag ${r.is_dual_eligible ? 'is-dual' : 'is-senior'}`,
              text: r.is_dual_eligible ? '双适龄 U-19' : '成年'
            })
          ),
          h(
            'div',
            { class: 'roster-skater-name' },
            h('b', { text: nm.zh }),
            nm.en ? h('small', { class: 'faint', text: nm.en }) : null
          ),
          sources.length
            ? h(
                'div',
                { class: 'roster-tags' },
                ...sources.map((src) => h('span', { class: 'roster-tag is-source', text: src }))
              )
            : null,
          h(
            'dl',
            { class: 'roster-reserve-stats' },
            h(
              'div',
              {},
              h('dt', { text: '正选边缘概率' }),
              h('dd', { class: 'num', text: pct(r.main_roster_prob) })
            ),
            h('div', {}, h('dt', { text: '首要顶替对象' }), h('dd', { text: repName })),
            h(
              'div',
              {},
              h('dt', { text: '边际替代损失' }),
              h('dd', {
                class: 'num',
                text: r.marginal_loss != null ? Number(r.marginal_loss).toFixed(4) : '—'
              })
            )
          ),
          r.recent_highlight
            ? h('p', { class: 'roster-highlight faint', text: r.recent_highlight })
            : null
        );
      })
    );

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '6 人替补名单' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: '6 人替补池' }),
        h('p', { text: '按短距离/接力 · 中长距离 · 综合机动三路配置' })
      ),
      summaryChips,
      grid
    );
  }

  async function render(ctx, prefetched = {}) {
    const { h, root, fetchData } = ctx;
    const params = new URLSearchParams(location.search);
    const state = {
      event: params.get('event') === 'wc' ? 'wc' : 'wt',
      gender: params.get('gender') === 'men' ? 'men' : 'women'
    };

    root.replaceChildren(
      h(
        'section',
        { class: 'season-head' },
        h('h1', { text: '中国队阵容与名额' }),
        h('p', { class: 'lead', text: '2026/27 ISU 名额核算与动态阵容预测' })
      ),
      h('p', { class: 'faint', role: 'status', text: '正在读取名额与阵容数据…' })
    );

    let quotas, forecast;
    try {
      const qPromise = prefetched.quotaData || fetchData('quota_roster/quotas_2026_27.json');
      const fPromise =
        prefetched.forecastData || fetchData('quota_roster/chn_roster_forecast.json');
      [quotas, forecast] = await Promise.all([qPromise, fPromise]);
    } catch (_) {
      root.replaceChildren(
        h(
          'section',
          { class: 'panel empty-state' },
          h('h1', { text: '阵容数据暂时无法读取' }),
          h('p', { class: 'faint', text: '请稍后重试或返回其他页面。' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => render(ctx, {})
            },
            '重新加载'
          )
        )
      );
      return;
    }

    const lookup = buildAthleteLookup(forecast);
    const body = h('div', { class: 'roster-body' });

    const syncUrl = () => {
      const url = new URL(location.href);
      url.searchParams.set('event', state.event);
      url.searchParams.set('gender', state.gender);
      window.history.replaceState(null, '', url);
    };

    const eventBtns = [
      { id: 'wt', label: '2026/27 世巡赛', sub: '6 人上限 / 4 人特例' },
      { id: 'wc', label: '2027 首尔世锦赛', sub: '5 人上限 / Comm. 2805' }
    ].map((opt) =>
      h(
        'button',
        {
          type: 'button',
          class: 'roster-seg-btn',
          dataset: { value: opt.id },
          'aria-pressed': String(state.event === opt.id),
          onclick: () => {
            if (state.event === opt.id) return;
            state.event = opt.id;
            syncUrl();
            updateControls();
            draw();
          }
        },
        h('b', { text: opt.label }),
        h('small', { text: opt.sub })
      )
    );

    const genderBtns = [
      { id: 'women', label: '女子' },
      { id: 'men', label: '男子' }
    ].map((opt) =>
      h(
        'button',
        {
          type: 'button',
          class: 'roster-seg-btn is-compact',
          dataset: { value: opt.id },
          'aria-pressed': String(state.gender === opt.id),
          onclick: () => {
            if (state.gender === opt.id) return;
            state.gender = opt.id;
            syncUrl();
            updateControls();
            draw();
          }
        },
        h('b', { text: opt.label })
      )
    );

    const updateControls = () => {
      for (const btn of eventBtns)
        btn.setAttribute('aria-pressed', String(state.event === btn.dataset.value));
      for (const btn of genderBtns)
        btn.setAttribute('aria-pressed', String(state.gender === btn.dataset.value));
    };

    const draw = () => {
      const scenarioKey =
        state.event === 'wc' ? 'world_championships_2027' : 'world_tour_next_stop';
      const scenarioData = forecast.scenarios?.[scenarioKey]?.[state.gender];
      if (!scenarioData) {
        body.replaceChildren(
          h('section', { class: 'panel empty-state' }, h('p', { text: '暂无该场景阵容预测数据' }))
        );
        return;
      }
      body.replaceChildren(
        renderQuotaSection(h, quotas, forecast, state, lookup),
        renderMainSection(h, scenarioData, forecast, state, lookup),
        renderReservesSection(h, scenarioData, lookup)
      );
    };

    const controls = h(
      'div',
      { class: 'roster-controls' },
      h('div', { class: 'roster-seg', role: 'group', 'aria-label': '赛事场景' }, ...eventBtns),
      h('div', { class: 'roster-seg', role: 'group', 'aria-label': '组别' }, ...genderBtns)
    );

    root.replaceChildren(
      h(
        'section',
        { class: 'season-head' },
        h('h1', { text: '中国队阵容与名额' }),
        h('p', {
          class: 'lead',
          text: `${quotas.season || '2026-2027'} · 更新于 ${forecast.as_of_date || forecast.generated_at?.slice(0, 10) || ''}`
        })
      ),
      controls,
      body
    );
    draw();
  }

  site.roster = { render };
})();
