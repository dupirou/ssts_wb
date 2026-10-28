/* Comparison controls own selection state; the shared table owns result rendering. */
(function () {
  'use strict';
  const site = window.SSTS;
  const {scopeEvents, scopeCoverage, normalizeKind} = site.resultsModel;

  async function render(ctx, index, panel, summaryTable) {
    const {h} = ctx;
    const params = new URLSearchParams(location.search);
    const people = Object.fromEntries(index.athletes.map(person => [person.id, person]));
    const seasons = [...new Set(index.cycles.flatMap(cycle => cycle.seasons))]
      .filter(season => season <= index.current_season).sort().reverse();
    const select = site.ui.select;
    const mode = select(h, 'mode', '对比类型',
      [['season', '赛季'], ['cycle', '奥运周期'], ['event', '赛事']], params.get('mode'));
    const kind = select(h, 'kind', '赛事范围',
      [['worlds', '世锦赛'], ['olympics', '冬奥会'], ['circuit', '世界杯 / 世巡赛'], ['fourcontinents', '四大洲']],
      normalizeKind(params.get('kind')));
    const metric = select(h, 'metric', '对比指标',
      [['best', '最佳名次'], ['medals', '奖牌'], ['finals', 'A 组决赛人／队次'], ['rate', 'A 决赛率'], ['top8', '前 8 名人／队次']],
      params.get('metric'));
    const field = (text, control, name = control.name) => h('label', {class: 'field-' + name}, h('span', {text}), control);
    const kindField = field('赛事', kind);
    const objects = ['left', 'right', 'third'].map((name, position) => {
      const value = select(h, name, '对比对象' + ['一', '二', '三'][position], [], '');
      const season = select(h, name + '_season', '对象' + ['一', '二', '三'][position] + '赛季', [], '');
      const eventName = h('span', {class: 'compare-event-name', 'aria-hidden': true, hidden: true});
      const choice = h('div', {class: 'compare-choice'}, value, eventName);
      const eventKind = h('small', {class: 'compare-event-kind', hidden: true});
      return {value, season, choice, eventName, eventKind, controls: h('div', {class: 'compare-selection'}, season, choice, eventKind)};
    });
    const thirdField = field('对象三', objects[2].controls, 'third');
    const more = h('details', {class: 'compare-more'},
      h('summary', {'aria-label': '第三个对比对象'},
        h('span', {class: 'compare-more-icon', text: '＋'}),
        h('span', {class: 'compare-more-label', text: '第三项'})),
      h('div', {class: 'compare-more-panel'}, thirdField));
    const form = h('form', {class: 'review-tools compare-tools', role: 'search', 'aria-label': '成绩对比条件'},
      field('对比', mode), kindField, field('指标', metric), more);
    const body = h('div', {class: 'comparison-body'});
    let generation = 0;

    function options() {
      if (mode.value === 'event') return index.events.map(event => [event.id, event.title]);
      if (mode.value === 'cycle') return [...index.cycles].reverse().map(cycle => [cycle.id, cycle.label]);
      return seasons.map(season => [season, season]);
    }

    function fillOptions(control, values, desired, optional = false) {
      control.replaceChildren(
        ...(optional ? [h('option', {value: '', text: '不添加'})] : []),
        ...values.map(([value, text]) => h('option', {value, text})));
      if ([...control.options].some(option => option.value === desired)) control.value = desired;
    }

    function fillEvents(object, desired, optional) {
      const events = index.events.filter(event => event.season === object.season.value);
      fillOptions(object.value, events.map(event => [event.id, event.title.split(' · ').reverse().join(' · ')]), desired, optional);
    }

    // IDs are the URL contract; season controls are derived from the selected event.
    function resetObjects(initial = false) {
      const values = options();
      const preferredLeft = mode.value === 'event' ? values[0]?.[0]
        : mode.value === 'season' ? '2024/25' : 'beijing-2022';
      const requestedLeft = initial ? params.get('left') : null;
      const left = values.some(([id]) => id === requestedLeft) ? requestedLeft
        : values.some(([id]) => id === preferredLeft) ? preferredLeft : values[0]?.[0];
      const preferredRight = mode.value === 'event'
        ? index.events.find(event => event.id !== left && event.kind === index.events.find(e => e.id === left)?.kind)?.id
        : mode.value === 'season' ? '2025/26' : 'milano-2026';
      const right = preferredRight !== left && values.some(([id]) => id === preferredRight)
        ? preferredRight : values.find(([id]) => id !== left)?.[0];
      objects.forEach((object, position) => {
        const desired = initial && params.has(object.value.name)
          ? params.get(object.value.name) : [left, right, ''][position];
        object.season.hidden = mode.value !== 'event';
        if (mode.value === 'event') {
          const eventSeasons = [...new Set(index.events.map(event => event.season))].sort().reverse();
          const chosen = index.events.find(event => event.id === desired);
          const fallback = index.events.find(event => event.id === [left, right][position]);
          fillOptions(object.season, eventSeasons.map(season => [season, season]), chosen?.season || fallback?.season);
          fillEvents(object, chosen?.id || [left, right, ''][position], position === 2);
        } else {
          fillOptions(object.value, values, desired, position === 2);
        }
      });
    }

    function selectedEvents(id) {
      return mode.value === 'event' ? index.events.filter(event => event.id === id)
        : scopeEvents(index, mode.value, id, kind.value);
    }

    async function draw() {
      const request = ++generation;
      const eventMode = mode.value === 'event';
      kindField.hidden = eventMode;
      form.classList.toggle('compare-tools-events', eventMode);
      const third = objects[2];
      more.querySelector('.compare-more-icon').textContent = third.value.value ? '−' : '＋';
      more.querySelector('summary').setAttribute('aria-label', third.value.value ? '移除第三个对比对象' : '添加第三个对比对象');
      if (!third.value.value) thirdField.append(third.controls);
      const selected = objects.filter((object, position) => position < 2 || object.value.value);
      const ids = selected.map(object => object.value.value);
      const sets = ids.map(selectedEvents);
      objects.forEach(object => {
        const event = index.events.find(event => event.id === object.value.value);
        object.choice.classList.toggle('is-event', eventMode);
        object.eventName.hidden = !eventMode;
        object.eventName.textContent = event ? event.title.split(' · ').at(-1) : '不添加';
        object.eventKind.hidden = !eventMode || !event;
        object.eventKind.textContent = event?.title.split(' · ')[0] || '';
        object.value.title = eventMode && event ? event.title : '';
      });
      try {
        await ctx.resultsStore.ensureStats(sets.flat());
      } catch (_) {
        if (request === generation) body.replaceChildren(
          h('p', {role: 'alert', text: '统计暂时无法加载'}),
          h('button', {type: 'button', text: '重试', onclick: draw}));
        return;
      }
      if (request !== generation) return;
      const names = ids.map(id => {
        const event = index.events.find(event => event.id === id);
        return eventMode && event ? event.season + ' · ' + event.title
          : options().find(([value]) => value === id)?.[1] || id;
      });
      const scopes = sets.map((events, position) => eventMode
        ? {singleEvent: true, known: true, expected: 1, partial: events.some(event => event.coverage !== 'complete')}
        : scopeCoverage(index, mode.value, ids[position], kind.value, events));
      const periods = mode.value === 'cycle' ? ids.map(id => index.cycles.find(cycle => cycle.id === id)?.seasons) : null;
      const table = summaryTable(ctx, sets, names, people, metric.value, periods,
        selected.map(object => object.controls), scopes, () => request === generation);
      if (new Set(ids).size !== ids.length) {
        table.querySelector('tbody').replaceChildren();
        body.replaceChildren(h('p', {class: 'review-notice', role: 'status', text: '请选择不同的对比对象'}), table);
      } else {
        body.replaceChildren(table);
      }
    }

    function update() {
      site.ui.writeFilters([mode, ...objects.map(object => object.value), kind, metric]);
      if (mode.value === 'event') {
        const url = new URL(location.href);
        url.searchParams.delete('kind');
        window.history.replaceState(null, '', url);
      }
      return draw();
    }

    more.querySelector('summary').addEventListener('click', event => {
      if (!objects[2].value.value) return;
      event.preventDefault();
      objects[2].value.value = '';
      more.open = false;
      update();
    });
    form.addEventListener('submit', event => event.preventDefault());
    panel.addEventListener('change', event => {
      if (event.target === mode) resetObjects();
      objects.forEach((object, position) => {
        if (event.target === object.season) fillEvents(object, object.value.value, position === 2);
        if (event.target === object.value && position === 2) more.open = false;
      });
      update();
    });
    resetObjects(true);
    panel.replaceChildren(
      h('div', {class: 'results-heading'}, h('h1', {text: '成绩对比'}), h('span', {class: 'country-label', text: 'CHN'})),
      form, body);
    await draw();
  }

  site.resultsCompare = {render};
})();
