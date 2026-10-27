/* Shared DOM, filter and table primitives; no business data. */
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const site = window.SSTS = window.SSTS || {};
  function h(name, props, ...kids) {
    const el = document.createElement(name);
    setProps(el, props);
    append(el, kids);
    return el;
  }
  function s(name, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
    append(el, kids);
    return el;
  }
  function setProps(el, props) {
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }
  // replaceChildren() would print null/false; fill() skips them like h().
  const fill = (el, ...kids) => { el.replaceChildren(); append(el, kids); return el; };
  function select(h,name,label,values,value) {
    const el = h('select',{name,'aria-label':label},values.map(([value,text]) => h('option',{value,text})));
    if (values.some(([id]) => id === value)) el.value = value;
    return el;
  }
  function writeFilters(controls,path) {
    const url = new URL(location.href);
    if (path) url.pathname = path;
    url.searchParams.delete('view');
    for (const el of controls) {
      if (el.value && el.value !== 'all') url.searchParams.set(el.name,el.value);
      else url.searchParams.delete(el.name);
    }
    window.history.replaceState(null,'',url);
  }
  const tableScroll = (h,table,label,cls='stats-scroll') => h('div',{class:cls,tabindex:'0','aria-label':label},table);
  site.ui = {h,s,append,fill,select,writeFilters,tableScroll};
})();
