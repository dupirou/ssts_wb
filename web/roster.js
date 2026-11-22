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

  const ROLE_LABELS = {
    sprint_relay: '短距离 / 接力',
    mid_long: '中长距离',
    versatile_upside: '综合机动'
  };

  const QUAL_PATH_LABELS = {
    WT_2026_27: '本季WT',
    JWC_2026_27: '青杯梯队',
    DOMESTIC_GOLD: '七台河金牌',
    DOMESTIC_TOP3: '七台河前三'
  };

  function formatTop40Tag(dists) {
    if (!Array.isArray(dists) || !dists.length) return null;
    const clean = dists.map((d) => String(d).replace(/m$/i, '')).join('·');
    return `Top40: ${clean}m`;
  }

  function hasAnyWorldRank(worldRanks) {
    if (!worldRanks || typeof worldRanks !== 'object') return false;
    return ['500', '1000', '1500'].some(
      (d) => extractRankNumber(worldRanks[d] ?? worldRanks[d + 'm']) != null
    );
  }

  function channelAndTop40Tags(h, record, lookup, showTop40Fallback = false) {
    const base = record.athlete_id ? lookup?.byId.get(record.athlete_id) : null;
    const qPath = record.qualification_path || base?.qualification_path || null;
    const top40 = record.world_ranking_top40_distances?.length
      ? record.world_ranking_top40_distances
      : base?.world_ranking_top40_distances || null;
    const tags = [];
    if (qPath) {
      tags.push(h('span', { class: 'roster-tag is-qual', text: QUAL_PATH_LABELS[qPath] || qPath }));
    }
    if (showTop40Fallback) {
      const top40Text = formatTop40Tag(top40);
      if (top40Text) {
        tags.push(h('span', { class: 'roster-tag is-top40', text: top40Text }));
      }
    }
    return tags;
  }

  const DIST_KEYS = ['500', '1000', '1500', 'relay'];
  const DIST_LABELS = { 500: '500m', 1000: '1000m', 1500: '1500m', relay: '接力' };

  const ZONE_META = {
    SAFE: { label: '主力安全', cls: 'is-safe' },
    PROTECT: { label: '保席临界', cls: 'is-protect' },
    CHASE: { label: '冲席边缘', cls: 'is-chase' },
    INACTIVE_TOP40: { label: '未出战老积分', cls: 'is-inactive' },
    INACTIVE: { label: '未出战老积分', cls: 'is-inactive' },
    OUT: { label: '前40外', cls: 'is-out' }
  };

  const SPECIALTY_LABELS = {
    sprint_relay: '短距离 / 接力',
    mid_long: '中长距离',
    all_round: '全能主力'
  };

  const formatSignedMargin = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const r = Math.round(n);
    return r > 0 ? '+' + r : String(r);
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

  const BUILTIN_CHN_NAMES = [
    ['Chutong ZHANG', '张楚桐'],
    ['Li GONG', '公俐'],
    ['Long SUN', '孙龙'],
    ['Bohao ZHANG', '张柏浩'],
    ['Ye WANG', '王晔'],
    ['Xinran WANG', '王欣然'],
    ['Jiarui SONG', '宋佳蕊'],
    ['Jianing ZHANG', '张珈宁'],
    ['Yan ZHANG', '张延'],
    ['Kun LI', '李坤'],
    ['Yiding ZHU', '朱祎玎'],
    ['Kerui SONG', '宋柯睿'],
    ['Zixia ZHANG', '张子夏']
  ];

  function buildAthleteLookup(forecast) {
    const byId = new Map();
    const byNameKey = new Map();
    for (const [en, zh] of BUILTIN_CHN_NAMES) {
      byNameKey.set(normNameKey(en), { name_en: en, name_zh: zh });
    }
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

  function extractRankNumber(val) {
    if (Number.isFinite(val)) return val;
    if (val && typeof val === 'object' && Number.isFinite(val.rank)) return val.rank;
    return null;
  }

  function topRankedDistance(worldRanks) {
    let bestDist = null;
    let bestRank = Infinity;
    for (const [dist, raw] of Object.entries(worldRanks || {})) {
      const rank = extractRankNumber(raw);
      if (rank != null && rank < bestRank) {
        bestRank = rank;
        bestDist = dist;
      }
    }
    return bestDist ? { dist: bestDist, rank: bestRank } : null;
  }

  function formatWorldRanks(worldRanks) {
    if (!worldRanks || typeof worldRanks !== 'object') return '暂无世界排名';
    const parts = [];
    for (const d of ['500', '1000', '1500']) {
      const rank = extractRankNumber(worldRanks[d] ?? worldRanks[d + 'm']);
      if (rank != null) parts.push(`${d}m #${rank}`);
    }
    return parts.length ? parts.join(' · ') : '暂无世界排名';
  }

  function formatRecommendedEntries(candidate, preferredEntries) {
    const fromPreferred = DIST_KEYS.filter((d) =>
      (preferredEntries?.[d] || []).includes(candidate.athlete_id)
    );
    const raw = fromPreferred.length
      ? fromPreferred
      : Array.isArray(candidate.recommended_entries)
        ? candidate.recommended_entries
        : [];
    const normalized = [];
    for (const item of raw) {
      const key = String(item).replace(/m$/i, '');
      if (key && !normalized.includes(key)) normalized.push(key);
    }
    if (!normalized.length) return '—';
    return normalized.map((k) => DIST_LABELS[k] || `${k}m`).join(' · ');
  }

  function renderTop40Watch(h, forecast, gender) {
    const watchByDist = forecast.top40_watch?.[gender];
    if (!watchByDist || typeof watchByDist !== 'object') return null;
    const distCols = ['500', '1000', '1500']
      .map((d) => [d, watchByDist[d] || watchByDist[Number(d)]])
      .filter(([, col]) => col && typeof col === 'object');
    if (!distCols.length) return null;

    return h(
      'div',
      { class: 'roster-top40-watch', 'aria-label': '世界排名 Top-40 与 4 席名额守门' },
      h('div', { class: 'roster-subhead' }, h('h3', { text: '世界排名 Top-40 与 4 席名额线' })),
      h(
        'div',
        { class: 'roster-top40-grid' },
        ...distCols.map(([d, col]) => {
          const slots = col.slots ?? 3;
          const slotText = slots >= 4 ? `${slots} 席特例` : `${slots} 席常规`;
          const activeCount = col.top40_active_chn ?? 0;
          const totalCount = col.top40_total_chn;
          const countText =
            totalCount != null && totalCount !== activeCount
              ? `现役前40: ${activeCount}人（总${totalCount}人）`
              : `现役前40: ${activeCount}人`;
          const cutoffText = `#40 门槛线: ${col.cutoff_points ?? '—'} 分${col.as_of ? ' · ' + col.as_of.slice(0, 10) : ''}`;
          const skaters = Array.isArray(col.skaters) ? col.skaters : [];
          const statusCls =
            col.status === 'SAFE' ? 'is-safe' : col.status === 'TIGHT' ? 'is-warn' : 'is-danger';

          return h(
            'div',
            { class: 'roster-top40-col', dataset: { distance: d } },
            h(
              'div',
              { class: 'roster-top40-col-head' },
              h(
                'div',
                { class: 'roster-top40-title' },
                h('b', { text: `${d}m` }),
                h('span', { class: `roster-status-pill ${statusCls}`, text: slotText })
              ),
              h(
                'div',
                { class: 'roster-top40-meta num faint' },
                h('span', { text: countText }),
                h('span', { text: cutoffText })
              )
            ),
            skaters.length
              ? h(
                  'ul',
                  { class: 'roster-top40-list' },
                  ...skaters.map((s) => {
                    const zm = ZONE_META[s.zone] || ZONE_META.OUT;
                    const margin = formatSignedMargin(s.margin_vs_top40);
                    const marginNum = Number(s.margin_vs_top40);
                    const marginCls = marginNum > 0 ? 'is-pos' : marginNum < 0 ? 'is-neg' : '';
                    return h(
                      'li',
                      { class: `roster-top40-row ${zm.cls}` },
                      h('span', { class: 'roster-top40-rank num', text: `#${s.rank ?? '—'}` }),
                      h('span', {
                        class: 'roster-top40-name',
                        text: s.name_zh || s.name_en || s.athlete_id || '未知选手'
                      }),
                      h(
                        'span',
                        { class: 'roster-top40-pts num' },
                        `${s.points ?? '—'} 分`,
                        h('small', {
                          class: `roster-top40-margin ${marginCls}`,
                          text: ` (${margin})`
                        })
                      ),
                      h('span', { class: `roster-zone-pill ${zm.cls}`, text: zm.label })
                    );
                  })
                )
              : h('p', { class: 'faint tiny', text: '暂无排名记录' })
          );
        })
      )
    );
  }

  function renderQuotaSection(h, quotas, forecast, state, lookup) {
    const { event, gender } = state;
    const isWt = event === 'wt' || event === 'wt_beijing';
    const isBeijing = event === 'wt_beijing';
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
      let note = null;
      if (isWt) {
        if (fourSet.has(dist)) note = 'Top-40 4 人特例';
      } else if (upgradedSet.has(dist)) {
        note = '东道主补足';
      }
      return h(
        'div',
        { class: 'roster-quota-chip' },
        h('span', { class: 'roster-quota-label', text: `${dist} 席位` }),
        h('b', { class: 'roster-quota-val num', text: `${slots} 人` }),
        note ? h('small', { class: 'roster-quota-sub', text: note }) : null
      );
    });

    const relayText = (row, label) => {
      if (!row) return `${label}：暂无排名`;
      const suffix = row.qualified === false ? ' · 暂列资格线外' : '';
      return `${label}：暂列第 ${row.official_rank} 名 · ${row.points} 分${suffix}`;
    };

    const quotaGrid = h(
      'div',
      { class: 'roster-quota-grid' },
      h(
        'div',
        { class: 'roster-quota-chip is-accent' },
        h('span', {
          class: 'roster-quota-label',
          text: `${genderLabel}${isWt ? '' : '预计'}总注册上限`
        }),
        h('b', { class: 'roster-quota-val num', text: `${chnQuota.max_roster_size ?? '—'} 人` })
      ),
      ...distCards,
      h(
        'div',
        { class: 'roster-quota-chip is-relay' },
        h('span', { class: 'roster-quota-label', text: '接力暂列排名' }),
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
    const allBans =
      forecast?.penalty_bans_all_members || quotas.world_tour_2026_27?.next_stop_penalty_bans || [];
    const allWarnings = quotas.world_tour_2026_27?.one_away_from_ban_warnings || [];
    const chnBans = forecast?.penalty_bans_applied || allBans.filter((b) => b.country === 'CHN');
    const chnWarnings =
      forecast?.penalty_warnings_chn || allWarnings.filter((w) => w.country === 'CHN');

    const targetStop = isBeijing ? 'beijing' : forecast?.next_wt_stop?.id;
    const penaltyCurrent =
      !('penalty_target_stop' in quotas) ||
      (targetStop && targetStop === quotas.penalty_target_stop);
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
          `中国队禁报 ${chnBans.length} 人`
        ),
        h('span', { class: 'roster-status-pill is-warn' }, `距禁报差 1 次 ${chnWarnings.length} 人`)
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
                  text: `累计 ${b.cumulative_penalties} 次 · 禁报 ${(b.blocked_distances || []).join(' / ') || b.blocked_count + ' 项，项目待定'}`
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
                  text: `累计 ${w.cumulative_penalties} 次${
                    top ? ` · 临界 ${top.dist} (#${top.rank})` : ''
                  }`
                })
              );
            })
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
              return rec ? `暂列线外 (#${rec.official_rank})` : '—';
            }
            return rec ? `暂列 #${rec.official_rank} (${rec.points}分)` : '暂列入围';
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

    const top40WatchPanel = isWt && forecast ? renderTop40Watch(h, forecast, gender) : null;
    const bjMeta = forecast?.scenarios?.world_tour_beijing;
    const nextStopText = isBeijing
      ? `目标分站：${bjMeta?.city || 'Beijing'} (${bjMeta?.date_start || '2026-12-04'})`
      : isWt && forecast?.next_wt_stop
        ? `下一站：${forecast.next_wt_stop.city || 'Shanghai'} (${forecast.next_wt_stop.date_start || ''})`
        : null;

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '名额与规则看板' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: '名额与规则看板' }),
        nextStopText ? h('p', { text: nextStopText }) : null
      ),
      quotaGrid,
      quotas.relay_as_of
        ? h('small', {
            class: 'faint',
            text: `接力榜数据日期 · ${genderRelayLabel} ${quotas.relay_as_of[genderRelayKey]?.slice(0, 10)} · 混合 ${quotas.relay_as_of.mixed_2000m?.slice(0, 10)}`
          })
        : null,
      top40WatchPanel,
      isWt && penaltyCurrent
        ? penaltyBar
        : isWt
          ? h('p', { class: 'faint', text: '本场禁报名单待核对' })
          : null,
      countriesDetails
    );
  }

  function tierBadgeMeta(tier, state) {
    if (tier === 'core') return { text: '稳固主力', cls: 'is-core' };
    if (tier === 'bubble') {
      return {
        text: state.event === 'wc' ? '第5人压线席位' : '轮换 / 保席边缘',
        cls: 'is-bubble'
      };
    }
    if (tier === 'cut') {
      return {
        text: state.event === 'wc' ? '6缩5 裁撤边缘' : '本季WT轮换候补',
        cls: 'is-cut'
      };
    }
    return { text: '候选池', cls: 'is-pool' };
  }

  function renderCandidateCard(h, candidate, preferredEntries, lookup, state, tier) {
    const nm = displayName(candidate, lookup);
    const isDual = candidate.is_dual_eligible === true || candidate.age_group === 'DUAL_ELIGIBLE';
    const badge = tierBadgeMeta(tier, state);
    const isMain = tier === 'core' || tier === 'bubble';
    const specLabel =
      candidate.specialty_label || SPECIALTY_LABELS[candidate.specialty_tag] || null;
    const entriesText = formatRecommendedEntries(candidate, preferredEntries);
    const hasRanks = hasAnyWorldRank(candidate.world_ranks);
    const ranksText = formatWorldRanks(candidate.world_ranks);
    const secondLabel = hasRanks || !candidate.recent_highlight ? '世界排名' : '近期成绩';
    const secondValue = hasRanks ? ranksText : candidate.recent_highlight || ranksText;
    const tags = [
      ...(isDual ? [h('span', { class: 'roster-tag is-dual', text: '双适龄 U-19' })] : []),
      ...channelAndTop40Tags(h, candidate, lookup, !hasRanks),
      ...(specLabel
        ? [
            h('span', {
              class: `roster-tag is-specialty is-spec-${candidate.specialty_tag || 'default'}`,
              text: specLabel
            })
          ]
        : [])
    ];

    return h(
      'article',
      {
        class: `roster-skater-card${isMain ? ' is-main' : ''} is-${tier}`,
        dataset: { athleteId: candidate.athlete_id, tier }
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
        h('span', { class: `roster-tier-badge ${badge.cls}`, text: badge.text })
      ),
      tags.length ? h('div', { class: 'roster-tags' }, ...tags) : null,
      h(
        'dl',
        { class: 'roster-skater-facts' },
        h(
          'div',
          { class: 'roster-fact-row' },
          h('dt', { text: '推荐报项' }),
          h('dd', { text: entriesText })
        ),
        h(
          'div',
          { class: 'roster-fact-row' },
          h('dt', { text: secondLabel }),
          h('dd', { class: 'num', text: secondValue })
        )
      )
    );
  }

  function renderMainSection(h, scenarioData, forecast, state, lookup) {
    const preferred = scenarioData.preferred_main_roster || { athlete_ids: [], entries: {} };
    const candidates = scenarioData.candidates || [];
    const byId = new Map(candidates.map((c) => [c.athlete_id, c]));

    let coreIds, bubbleIds, cutIds;
    if (scenarioData.roster_tiers) {
      coreIds = (scenarioData.roster_tiers.core_ids || []).filter((id) => byId.has(id));
      bubbleIds = (scenarioData.roster_tiers.bubble_ids || []).filter((id) => byId.has(id));
      cutIds = (scenarioData.roster_tiers.cut_ids || []).filter((id) => byId.has(id));
    } else {
      const preferredIds = (
        preferred.ordered_ids?.length ? preferred.ordered_ids : preferred.athlete_ids || []
      ).filter((id) => byId.has(id));
      const coreCount =
        preferredIds.length === 0
          ? 0
          : Math.max(1, preferredIds.length <= 5 ? preferredIds.length - 1 : 4);
      coreIds = preferredIds.slice(0, coreCount);
      bubbleIds = preferredIds.slice(coreCount);
      const prefSet = new Set(preferredIds);
      cutIds = candidates
        .filter((c) => !prefSet.has(c.athlete_id) && c.qualification_path === 'WT_2026_27')
        .map((c) => c.athlete_id);
    }

    const assignedSet = new Set([...coreIds, ...bubbleIds, ...cutIds]);
    const coreCandidates = coreIds.map((id) => byId.get(id)).filter(Boolean);
    const bubbleCandidates = bubbleIds.map((id) => byId.get(id)).filter(Boolean);
    const cutCandidates = cutIds.map((id) => byId.get(id)).filter(Boolean);
    const otherCandidates = candidates.filter((c) => !assignedSet.has(c.athlete_id));

    const coreBlock = h(
      'div',
      { class: 'roster-tier-block is-core' },
      h(
        'div',
        { class: 'roster-subhead' },
        h('h3', { text: `稳固主力（${coreCandidates.length} 人）` })
      ),
      h(
        'div',
        { class: 'roster-main-grid' },
        ...coreCandidates.map((c) =>
          renderCandidateCard(h, c, preferred.entries, lookup, state, 'core')
        )
      )
    );

    const bubbleBlock =
      bubbleCandidates.length || cutCandidates.length
        ? h(
            'div',
            { class: 'roster-tier-block is-bubble' },
            h(
              'div',
              { class: 'roster-subhead' },
              h('h3', {
                text: `淘汰 / 轮换边缘（${bubbleCandidates.length + cutCandidates.length} 人）`
              })
            ),
            h(
              'div',
              { class: 'roster-main-grid' },
              ...bubbleCandidates.map((c) =>
                renderCandidateCard(h, c, preferred.entries, lookup, state, 'bubble')
              ),
              ...cutCandidates.map((c) =>
                renderCandidateCard(h, c, preferred.entries, lookup, state, 'cut')
              )
            )
          )
        : null;

    const allToggle =
      otherCandidates.length > 0
        ? h(
            'details',
            { class: 'roster-all-candidates' },
            h('summary', {
              text: `其余候选池（${otherCandidates.length} 人）`
            }),
            h(
              'div',
              { class: 'roster-main-grid' },
              ...otherCandidates.map((c) =>
                renderCandidateCard(h, c, preferred.entries, lookup, state, 'pool')
              )
            )
          )
        : null;

    const excluded = forecast.excluded_by_age?.[state.gender] || [];
    const excludedNote = excluded.length
      ? h(
          'p',
          { class: 'roster-excluded-note faint' },
          `青年组未满成年龄（${excluded.length} 人）：` +
            excluded.map((e) => e.name_zh || e.name_en).join('、')
        )
      : null;

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '主力阵容与淘汰边缘' },
      h('div', { class: 'panel-head' }, h('h2', { text: '中国队主力与淘汰 / 轮换边缘' })),
      coreBlock,
      bubbleBlock,
      allToggle,
      excludedNote
    );
  }

  function renderReservesSection(h, scenarioData, state, lookup) {
    const reserves = [...(scenarioData.reserves || [])].sort(
      (a, b) => (a.reserve_rank || 99) - (b.reserve_rank || 99)
    );
    const reserveCap = scenarioData.reserve_cap ?? reserves.length;
    const headingText =
      reserves.length < reserveCap
        ? `替补梯队（${reserves.length} / ${reserveCap} 人）`
        : `替补梯队（${reserveCap} 人）`;

    const grid = h(
      'div',
      { class: 'roster-reserve-grid' },
      ...reserves.map((r) => {
        const nm = displayName(r, lookup);
        const repName = r.primary_replacement_for
          ? shortName(r.primary_replacement_for, lookup)
          : '—';
        const roleLabel = ROLE_LABELS[r.role_tag] || r.role_tag;
        const base = r.athlete_id ? lookup?.byId.get(r.athlete_id) : null;
        const worldRanks = r.world_ranks || base?.world_ranks;
        const hasRanks = hasAnyWorldRank(worldRanks);
        const ranksText = formatWorldRanks(worldRanks);
        const extraTags = channelAndTop40Tags(h, r, lookup, !hasRanks);
        const qPath = r.qualification_path || base?.qualification_path || null;
        const qualText = QUAL_PATH_LABELS[qPath] || '候选池';
        const highlight = (r.recent_highlight || base?.recent_highlight || '').replace(
          /^(?:2026\/27\s+|国内甲组\s+)/,
          ''
        );
        const secondLabel = hasRanks ? '世界排名' : '近期成绩';
        const secondVal = hasRanks ? ranksText : highlight || qualText;

        return h(
          'article',
          { class: 'roster-reserve-card', dataset: { roleTag: r.role_tag } },
          h(
            'div',
            { class: 'roster-reserve-head' },
            h('span', { class: 'roster-reserve-rank num', text: `#${r.reserve_rank}` }),
            h('span', { class: `roster-tag is-role-${r.role_tag}`, text: roleLabel }),
            ...extraTags,
            r.is_dual_eligible
              ? h('span', { class: 'roster-tag is-dual', text: '双适龄 U-19' })
              : null
          ),
          h(
            'div',
            { class: 'roster-skater-name' },
            h('b', { text: nm.zh }),
            nm.en ? h('small', { class: 'faint', text: nm.en }) : null
          ),
          h(
            'dl',
            { class: 'roster-reserve-stats' },
            h('div', {}, h('dt', { text: '对位顶替' }), h('dd', { text: repName })),
            h('div', {}, h('dt', { text: secondLabel }), h('dd', { class: 'num', text: secondVal }))
          )
        );
      })
    );

    return h(
      'section',
      { class: 'panel roster-section', 'aria-label': '替补梯队' },
      h('div', { class: 'panel-head' }, h('h2', { text: headingText })),
      reserves.length ? grid : h('p', { class: 'faint', text: '暂无替补人选' })
    );
  }

  async function render(ctx, prefetched = {}) {
    const { h, root, fetchData } = ctx;
    const params = new URLSearchParams(location.search);
    const rawEvent = params.get('event');
    const state = {
      event: rawEvent === 'wc' ? 'wc' : rawEvent === 'wt_beijing' ? 'wt_beijing' : 'wt',
      gender: params.get('gender') === 'men' ? 'men' : 'women'
    };

    root.replaceChildren(
      h(
        'section',
        { class: 'season-head' },
        h('h1', { text: '中国队阵容与名额' }),
        h('p', { class: 'lead', text: '2026/27 ISU 名额核算' })
      ),
      h('p', { class: 'faint', role: 'status', text: '正在读取名额数据…' })
    );

    let quotas;
    let forecast = null;
    try {
      quotas = await (prefetched.quotaData || fetchData('quota_roster/quotas_2026_27.json'));
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

    let lookup = buildAthleteLookup(null);
    const body = h('div', { class: 'roster-body' });
    const analysisControls = h('div', { class: 'analysis-controls roster-analysis-controls' });
    const message = h('span', { class: 'analysis-msg faint tiny', role: 'status' });
    const leadEl = h('p', {
      class: 'lead',
      text: `${quotas.season || '2026-2027'} · 更新于 ${(quotas.generated_at || '').slice(0, 10)}`
    });

    let unlocked = false;
    try {
      unlocked = localStorage.getItem('ssts.analysis') === '1';
    } catch {}

    function rememberAnalysis(value) {
      unlocked = value;
      try {
        if (value) localStorage.setItem('ssts.analysis', '1');
        else localStorage.removeItem('ssts.analysis');
      } catch {}
    }

    const callAnalysis = (data) =>
      fetch('/internal/analysis', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

    const syncUrl = () => {
      const url = new URL(location.href);
      url.searchParams.set('event', state.event);
      url.searchParams.set('gender', state.gender);
      window.history.replaceState(null, '', url);
    };

    const eventBtns = [
      { id: 'wt', label: '世巡赛 · 下一站' },
      { id: 'wt_beijing', label: '世巡赛 · 北京站' },
      { id: 'wc', label: '2027 首尔世锦赛' }
    ].map((opt) =>
      h(
        'button',
        {
          type: 'button',
          class: 'roster-seg-btn is-compact',
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
        h('b', { text: opt.label })
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
      const next = forecast?.next_wt_stop;
      const nextBtn = eventBtns.find((b) => b.dataset.value === 'wt');
      nextBtn.querySelector('b').textContent = next?.city_zh
        ? `世巡赛 · ${next.city_zh}站`
        : '世巡赛 · 下一站';
      const beijingBtn = eventBtns.find((b) => b.dataset.value === 'wt_beijing');
      beijingBtn.hidden = next?.id === 'beijing' && state.event !== 'wt_beijing';
      const quotaSection = renderQuotaSection(h, quotas, unlocked ? forecast : null, state, lookup);
      if (!unlocked || !forecast) {
        body.replaceChildren(quotaSection);
        return;
      }
      const scenarioKey =
        state.event === 'wc'
          ? 'world_championships_2027'
          : state.event === 'wt_beijing'
            ? 'world_tour_beijing'
            : 'world_tour_next_stop';
      const scenarioData = forecast.scenarios?.[scenarioKey]?.[state.gender];
      if (!scenarioData) {
        body.replaceChildren(
          quotaSection,
          h('section', { class: 'panel empty-state' }, h('p', { text: '暂无该场景阵容预测数据' }))
        );
        return;
      }
      body.replaceChildren(
        quotaSection,
        renderMainSection(h, scenarioData, forecast, state, lookup),
        renderReservesSection(h, scenarioData, state, lookup)
      );
    };

    async function loadForecast() {
      message.textContent = '正在加载预测…';
      if (!analysisControls.querySelector('form, .analysis-lock-bar')) {
        analysisControls.replaceChildren(message);
      }
      const response = await callAnalysis({ action: 'roster' });
      if ([401, 404].includes(response.status)) {
        rememberAnalysis(false);
        forecast = null;
        lookup = buildAthleteLookup(null);
        message.textContent = '';
        analysisControls.replaceChildren();
        draw();
        return;
      }
      if (!response.ok) throw new Error();
      forecast = await response.json();
      lookup = buildAthleteLookup(forecast);
      leadEl.textContent = `${quotas.season || '2026-2027'} · 更新于 ${forecast.as_of_date || forecast.generated_at?.slice(0, 10) || (quotas.generated_at || '').slice(0, 10)}`;
      message.textContent = '';
      analysisControls.replaceChildren();
      draw();
    }

    function toggleLockBar() {
      if (analysisControls.querySelector('.analysis-lock-bar')) {
        message.textContent = '';
        analysisControls.replaceChildren();
        return;
      }
      const lock = h('button', {
        type: 'button',
        class: 'analysis-btn is-danger',
        text: '锁定预测'
      });
      const cancel = h('button', { type: 'button', class: 'analysis-btn', text: '取消' });
      const bar = h('div', { class: 'analysis-lock-bar' }, lock, cancel, message);
      lock.onclick = async () => {
        lock.disabled = true;
        try {
          if (!(await callAnalysis({ action: 'logout' })).ok) throw new Error();
          rememberAnalysis(false);
          forecast = null;
          lookup = buildAthleteLookup(null);
          message.textContent = '';
          analysisControls.replaceChildren();
          draw();
        } catch {
          message.textContent = '锁定失败，请重试';
          lock.disabled = false;
        }
      };
      cancel.onclick = () => {
        message.textContent = '';
        analysisControls.replaceChildren();
      };
      message.textContent = '';
      analysisControls.replaceChildren(bar);
    }

    function login() {
      if (analysisControls.querySelector('form')) return;
      const input = h('input', {
        type: 'password',
        required: true,
        autocomplete: 'current-password',
        'aria-label': '预测密码',
        placeholder: '输入预测密码'
      });
      const submit = h('button', {
        type: 'submit',
        class: 'analysis-btn is-primary',
        text: '解锁'
      });
      const form = h('form', { class: 'analysis-login' }, input, submit, message);
      message.textContent = '';
      analysisControls.replaceChildren(form);
      input.focus();
      form.onsubmit = async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const response = await callAnalysis({ action: 'login', password: input.value });
          if (!response.ok) {
            message.textContent = response.status === 401 ? '密码有误' : '暂时无法解锁';
            input.select();
            return;
          }
          input.value = '';
          rememberAnalysis(true);
          await loadForecast();
        } catch {
          message.textContent = '连接失败，请重试';
        } finally {
          submit.disabled = false;
        }
      };
    }

    const titleTrigger = h('button', {
      type: 'button',
      text: '中国队阵容与名额',
      style: { all: 'unset', cursor: 'pointer', touchAction: 'manipulation' }
    });
    let taps = 0;
    let since = 0;
    titleTrigger.addEventListener('click', () => {
      if (Date.now() - since > 2500) taps = 0;
      if (!taps) since = Date.now();
      if (++taps === 5) {
        taps = 0;
        if (unlocked) toggleLockBar();
        else login();
      }
    });

    const controls = h(
      'div',
      { class: 'roster-controls' },
      h('div', { class: 'roster-seg', role: 'group', 'aria-label': '赛事场景' }, ...eventBtns),
      h('div', { class: 'roster-seg', role: 'group', 'aria-label': '组别' }, ...genderBtns)
    );

    root.replaceChildren(
      h('section', { class: 'season-head' }, h('h1', {}, titleTrigger), leadEl),
      analysisControls,
      controls,
      body
    );
    draw();

    if (unlocked) {
      await loadForecast().catch(() => {
        message.textContent = '预测暂时无法加载';
        analysisControls.replaceChildren(message);
      });
    }
  }

  site.roster = { render };
})();
