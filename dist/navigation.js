/* Shared page addresses and global navigation. Event query links remain valid. */
(function () {
  'use strict';
  const site = (window.SSTS = window.SSTS || {});
  const sections = [
    { id: 'home', label: '首页', href: '/', icon: 'home' },
    { id: 'events', label: '赛事', href: '/events/', icon: 'calendar' },
    { id: 'results', label: '成绩', href: '/results/', icon: 'history' },
    { id: 'athletes', label: '运动员', href: '/athletes/', icon: 'people' }
  ];
  function resolve(input) {
    const url = new URL(input.href || input, location.origin);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' && url.searchParams.has('station')) {
      return {
        page: 'event',
        section: 'events',
        event: url.searchParams.get('station'),
        legacy: true
      };
    }
    if (path === '/' && url.searchParams.get('view') === 'history')
      return { page: 'results', section: 'results', view: 'event', legacy: true };
    if (path === '/') return { page: 'home', section: 'home' };
    if (
      path === '/history' ||
      (path === '/results' &&
        ['view', 'cycle', 'season', 'event', 'kind', 'gender', 'distance', 'athlete'].some((key) =>
          url.searchParams.has(key)
        ))
    )
      return { page: 'results', section: 'results', view: 'event' };
    const results = path.match(/^\/results\/(events|seasons|cycles)(?:\/([a-z0-9-]+))?$/);
    if (results)
      return {
        page: 'results',
        section: 'results',
        view: { events: 'event', seasons: 'season', cycles: 'cycle' }[results[1]],
        id: results[2]
      };
    if (path === '/results/compare')
      return { page: 'results', section: 'results', view: 'compare' };
    const section = sections.find((s) => s.href.replace(/\/$/, '') === path);
    if (section) return { page: section.id, section: section.id };
    const event = path.match(/^\/events\/(\d{4}-\d{2})\/([a-z0-9-]+)$/);
    if (event) return { page: 'event', section: 'events', season: event[1], event: event[2] };
    return { page: 'not-found', section: null };
  }
  function eventHref(id, season) {
    return (
      '/events/' + encodeURIComponent(season.replace('/', '-')) + '/' + encodeURIComponent(id) + '/'
    );
  }
  function render(h, icon, route) {
    const nav = document.getElementById('site-nav');
    nav.replaceChildren(
      ...sections.map((s) =>
        h(
          'a',
          {
            href: s.href,
            class: 'site-nav-item',
            'aria-current': route.section === s.id ? 'page' : null
          },
          icon(s.icon),
          h('span', { text: s.label })
        )
      )
    );
  }
  site.navigation = { sections, resolve, eventHref, render };
})();
