/* Site-level pages. Current event details keep their own schedule and roster views. */
(function () {
  'use strict';
  const site = (window.SSTS = window.SSTS || {});
  function header(h, title, description) {
    return h(
      'section',
      { class: 'season-head' },
      h('h1', { text: title }),
      description ? h('p', { class: 'lead', text: description }) : null
    );
  }
  function home(ctx, calendar, details) {
    const { h, root, nextCard, stationWindow, phase, ticketPanel } = ctx;
    const stations = calendar.stations.map((st, i) => ({
      ...st,
      n: i + 1,
      detail: details[st.id],
      win: stationWindow(st, details[st.id])
    }));
    const events = [
      ...stations,
      ...(calendar.championships || []).map((st) => ({
        ...st,
        isChampionship: true,
        win: stationWindow(st, null)
      }))
    ];
    const focus =
      events.find((s) => phase(s.win) === 'live') ||
      events.find((s) => phase(s.win) === 'upcoming');
    root.replaceChildren(
      header(h, '短道速滑', calendar.season),
      focus
        ? nextCard(focus)
        : h(
            'section',
            { class: 'panel empty-state' },
            h('h2', { text: '本赛季比赛已结束' }),
            h('a', { class: 'btn', href: '/events/' }, '查看赛事')
          ),
      ...stations.map(ticketPanel).filter(Boolean)
    );
  }
  async function athletes(ctx, calendar) {
    const { h, root, fetchData } = ctx;
    root.replaceChildren(
      header(h, '运动员', calendar.season),
      h('p', { class: 'athlete-loading', role: 'status', text: '正在读取运动员名单…' })
    );
    try {
      const index = await fetchData('athletes.json');
      const form = h('form', {
        class: 'directory-tools',
        role: 'search',
        'aria-label': '查找运动员'
      });
      const q = h('input', {
        type: 'search',
        name: 'q',
        placeholder: '姓名或国家代码',
        'aria-label': '搜索运动员',
        autocomplete: 'off'
      });
      const country = h(
        'select',
        { name: 'country', 'aria-label': '运动员国家或地区' },
        h('option', { value: 'all', text: '全部国家 / 地区' }),
        [...new Set(index.items.map((p) => p.country))]
          .sort()
          .map((c) => h('option', { value: c, text: c }))
      );
      const sex = h(
        'select',
        { name: 'gender', 'aria-label': '运动员性别' },
        [
          ['all', '全部'],
          ['women', '女子'],
          ['men', '男子']
        ].map(([value, text]) => h('option', { value, text }))
      );
      const params = new URLSearchParams(location.search);
      q.value = params.get('q') || '';
      if ([...country.options].some((o) => o.value === params.get('country')))
        country.value = params.get('country');
      if (['women', 'men'].includes(params.get('gender'))) sex.value = params.get('gender');
      const count = h('p', { class: 'directory-count faint', role: 'status' });
      const list = h('ul', { class: 'directory-grid' });
      const draw = () => {
        const query = q.value.trim().toLocaleLowerCase();
        const people = index.items.filter(
          (p) =>
            (country.value === 'all' || p.country === country.value) &&
            (sex.value === 'all' || p.gender === sex.value) &&
            (!query ||
              query
                .split(/\s+/)
                .every((token) =>
                  (p.name + ' ' + p.country + ' ' + (p.aliases || []).join(' '))
                    .toLocaleLowerCase()
                    .includes(token)
                ))
        );
        count.textContent = '显示 ' + people.length + ' 人 · 共 ' + index.items.length + ' 人';
        list.replaceChildren(
          ...people.map((p) =>
            h(
              'li',
              { class: 'panel directory-card' },
              h(
                'div',
                { class: 'directory-identity' },
                h('span', {
                  class: p.country === 'CHN' ? 'athlete-china' : 'athlete-nation',
                  text: p.country
                }),
                h('h2', { text: p.name }),
                h('small', { class: 'faint', text: p.gender === 'women' ? '女子' : '男子' })
              ),
              p.season_rankings?.length
                ? h(
                    'section',
                    { class: 'directory-rankings', 'aria-label': '本赛季世巡赛排名' },
                    h('h3', { class: 'faint tiny', text: '本赛季世巡赛排名' }),
                    h(
                      'dl',
                      {},
                      p.season_rankings.map((r) =>
                        h(
                          'div',
                          {},
                          h('dt', { text: r.distance_m + 'm' }),
                          h('dd', { class: 'num', text: '第 ' + r.rank + ' 名' })
                        )
                      )
                    )
                  )
                : null
            )
          )
        );
        if (!people.length)
          list.append(h('li', { class: 'panel empty-state', text: '没有符合条件的运动员' }));
      };
      const update = () => {
        const url = new URL(location.href);
        for (const [name, value] of [
          ['q', q.value],
          ['country', country.value],
          ['gender', sex.value]
        ]) {
          if (value && value !== 'all') url.searchParams.set(name, value);
          else url.searchParams.delete(name);
        }
        window.history.replaceState(null, '', url);
        draw();
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        update();
      });
      q.addEventListener('input', update);
      country.addEventListener('change', update);
      sex.addEventListener('change', update);
      form.append(
        h(
          'label',
          { class: 'directory-search' },
          h('span', { class: 'sr-only', text: '姓名或国家代码' }),
          q
        ),
        country,
        sex
      );
      root.replaceChildren(
        header(h, '运动员', calendar.season),
        form,
        index.ranking_as_of?.length
          ? h('p', {
              class: 'ranking-as-of faint tiny',
              text: '排名截至' + index.ranking_as_of.map((e) => e.city + '站').join('、')
            })
          : null,
        count,
        list
      );
      draw();
    } catch (_) {
      root.replaceChildren(
        header(h, '运动员', calendar.season),
        h(
          'section',
          { class: 'panel empty-state' },
          h('h2', { text: '名单暂时无法加载' }),
          h(
            'button',
            { class: 'btn', type: 'button', onclick: () => athletes(ctx, calendar) },
            '重试'
          )
        )
      );
    }
  }
  site.portal = { home, athletes };
})();
