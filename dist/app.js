/* Presentation-only wireframe. Safe to replace without changing data schema. */
(async function () {
  'use strict';
  const root = document.getElementById('app');
  const q = (name) => new URLSearchParams(location.search).get(name);
  const tag = (name, text, className) => {
    const el = document.createElement(name);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  };
  const put = (parent, name, text, className) => {
    const e=tag(name,text,className);parent.appendChild(e);return e;
  };
  const fetchData = async (file) => {
    const response = await fetch('./data/' + file, {cache:'no-cache'});
    if (!response.ok) throw new Error('数据请求失败: ' + response.status);
    return response.json();
  };
  const gender={women:'女子',men:'男子',mixed:'混合'};
  const round={preliminaries:'初赛',heats:'预赛',quarterfinal:'1/4决赛',semifinal:'半决赛',final:'决赛'};
  const session={qualifying:'资格赛',repechage:'复活赛',main:'决赛阶段（含淘汰赛）'};
  const eventName = r => gender[r.gender] + ' ' + r.distance_m + 'm' + (r.format==='relay'?' 接力':'');
  const roundName = r => r.round==='final' ? r.group+'组决赛' : round[r.round];

  function choose(label, options, change) {
    const wrap=tag('label');put(wrap,'span',label);
    const select=tag('select');
    for (const [value,caption] of options) {
      const o=tag('option',caption);o.value=value;select.appendChild(o);
    }
    select.addEventListener('change',()=>change(select.value));
    wrap.appendChild(select);return wrap;
  }
  function renderCalendar(data) {
    put(root,'h1','2026/27 短道速滑世界巡回赛');
    const cards=put(root,'div',undefined,'cards');
    for(const [i,s] of data.stations.entries()) {
      const a=put(cards,'a',undefined,'card');
      a.href='?station='+encodeURIComponent(s.id);
      put(a,'div','STAGE '+String(i+1).padStart(2,'0'),'mono');
      put(a,'h2',s.city+' / '+s.city_en);
      put(a,'div',s.date_start+' — '+s.date_end,'mono');
      put(a,'p',s.detail_status==='verified'?'已录入逐项赛程':'逐项赛程待官方公布','sub');
    }
    const source=put(root,'p','赛历来源：ISU 官方赛历','sub');
    const link=put(source,'a','查看原始信息');link.href=data.source_url;link.rel='noopener noreferrer';link.target='_blank';
  }
  function renderStation(calendar, station, data) {
    const back=put(root,'a','← 返回赛季');back.href='./';
    put(root,'h1',station.city+'站 / '+station.city_en);
    put(root,'p',station.date_start+' — '+station.date_end+' · '+(station.venue||'场馆暂未录入')+' · '+station.timezone,'sub');
    if (!data) {
      put(root,'div','详细赛程待更新','panel');
      return;
    }
    if (data.sync?.last_successful_schedule_check_utc) {
      put(root,'p','赛程核对：'+new Date(data.sync.last_successful_schedule_check_utc).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）','sub');
    }
    const link=put(root,'a','ISU 逐项赛程原始页面');link.href=data.source_url;link.rel='noopener noreferrer';link.target='_blank';
    const info=put(root,'div',undefined,'panel china-next');
    const filters=put(root,'div',undefined,'controls');
    const state={day:'all',gender:'all',stage:'all',zone:'beijing'};
    const fields=[
      choose('比赛当地日期',[['all','全部日期'],...Object.keys(data.day_counts).map(d=>[d,d])],x=>{state.day=x;redraw()}),
      choose('项目',[['all','全部'],['women','女子'],['men','男子'],['mixed','混合'],['relay','全部接力']],x=>{state.gender=x;redraw()}),
      choose('轮次',[['all','全部'],['qualifying','资格赛'],['repechage','复活赛'],['main','决赛阶段'],['final','A/B组决赛']],x=>{state.stage=x;redraw()}),
      choose('时间优先',[['beijing','北京时间'],['local','温哥华时间']],x=>{state.zone=x;redraw()})
    ];
    fields.forEach(x=>filters.appendChild(x));
    const reset=put(filters,'button','重置筛选');
    reset.addEventListener('click',()=>{Object.assign(state,{day:'all',gender:'all',stage:'all',zone:'beijing'});fields.forEach(x=>x.querySelector('select').selectedIndex=0);redraw()});
    const counter=put(root,'p',undefined,'sub');
    const container=put(root,'div');
    const now=Date.now();
    const nextChina=data.entries.find(r=>r.china.status==='confirmed'&&Date.parse(r.utc_start)>now);
    info.textContent=nextChina
      ? '下一场中国队：'+eventName(nextChina)+' '+roundName(nextChina)+' 北京时间 '+nextChina.beijing_date+' '+nextChina.beijing_time
      : '中国队下一场：暂无已确认分组';
    function redraw() {
      container.replaceChildren();
      const rows=data.entries.filter(r=>
        (state.day==='all'||r.local_date===state.day)&&
        (state.gender==='all'||(state.gender==='relay'?r.format==='relay':r.gender===state.gender))&&
        (state.stage==='all'||(state.stage==='final'?r.round==='final':r.session===state.stage)));
      counter.textContent='显示 '+rows.length+' / '+data.entries.length+' 个官方计划开赛时点';
      const grouped={};
      for(const r of rows) (grouped[r.local_date]??=[]).push(r);
      for (const [day,items] of Object.entries(grouped)) {
        const section=put(container,'section',undefined,'date-box');
        put(section,'h2',day+'（温哥华当地日期）');
        const scroller=put(section,'div',undefined,'scroll');
        scroller.tabIndex=0;scroller.setAttribute('role','region');scroller.setAttribute('aria-label','时间表，可横向滚动');
        const table=put(scroller,'table');
        const thead=put(table,'thead');const htr=put(thead,'tr');
        const labels=state.zone==='beijing'
          ? ['日期','北京时间','温哥华时间','项目','轮次','组别','备注']
          : ['日期','温哥华时间','北京时间','项目','轮次','组别','备注'];
        labels.forEach(label=>put(htr,'th',label));
        const body=put(table,'tbody');let lastStage='';
        for(const r of items) {
          if (lastStage!==r.session) {
            const h=put(body,'tr',undefined,'session-row');
            const cell=put(h,'td',session[r.session]);cell.colSpan=7;
            lastStage=r.session;
          }
          const tr=put(body,'tr');
          if(r.china.status==='confirmed')tr.classList.add('china-row');
          if(r.group==='A')tr.classList.add('a-final');
          put(tr,'td',r.local_date,'mono');
          const beijing=r.beijing_date+' '+r.beijing_time;
          const times=state.zone==='beijing'?[beijing,r.local_time]:[r.local_time,beijing];
          times.forEach(x=>put(tr,'td',x,'time'));
          const name=put(tr,'td',eventName(r));
          if(r.china.status==='confirmed') put(name,'strong',' CHN 中国队','china-label');
          put(tr,'td',roundName(r));
          put(tr,'td',r.group||'—');
          const note=put(tr,'td',undefined,'tiny');
          if(r.china.status==='confirmed') {
            for(const h of r.china.heats) {
              const a=h.estimate,lo=state.zone==='beijing'?a.earliest_beijing:a.earliest_local;
              const hi=state.zone==='beijing'?a.latest_beijing:a.latest_local;
              put(note,'p','第'+h.number+'组 '+h.athletes.join('、')+' · 预计 '+lo.slice(11,16)+'–'+hi.slice(11,16)+'（估算）');
            }
            const provenance=put(note,'a','查看分组来源');
            provenance.href=r.china.source_url;provenance.target='_blank';provenance.rel='noopener noreferrer';
          }
        }
      }
      if(!rows.length)put(container,'div','当前筛选条件下无比赛。','panel');
    }
    redraw();
  }
  try {
    const calendar=await fetchData('calendar.json');
    const requested=q('station');
    if(!requested)return renderCalendar(calendar);
    const station=calendar.stations.find(s=>s.id===requested);
    if(!station)throw new Error('未知分站');
    const details=station.id==='vancouver'?await fetchData('vancouver.json'):null;
    renderStation(calendar,station,details);
  } catch(e) {
    root.replaceChildren();
    put(root,'p','无法加载赛程：'+e.message+'。请检查静态站点部署目录和数据文件。','panel');
  }
})();
