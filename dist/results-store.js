/* Results I/O boundary: immutable metadata, cached summaries, bounded detail requests. */
(function () {
  'use strict';
  const site = window.SSTS = window.SSTS || {};
  function create(fetchData) {
    const cache = new Map();
    let active = 0;
    const queue = [];
    const run = async (task) => {
      if (active >= 4) await new Promise(resolve => queue.push(resolve));
      active++;
      try {return await task();} finally {active--; queue.shift()?.();}
    };
    const read = (file,validate=()=>true) => {
      if (!cache.has(file)) {
        const promise = run(async()=>{const data=await fetchData(file);if(!validate(data))throw new Error('Invalid results data: '+file);return data;}).catch(error => {cache.delete(file); throw error;});
        cache.set(file,promise);
      }
      return cache.get(file);
    };
    const getIndex = () => read('results/index.json',data=>data.schema_version===2&&Array.isArray(data.events));
    async function ensureStats(events) {
      const seasons = [...new Set(events.filter(e => !e.summary).map(e => e.season))];
      const files = await Promise.all(seasons.map(season => read('results/seasons/' + season.replace('/','-') + '.json',data=>data.schema_version===2&&Array.isArray(data.items)&&events.filter(e=>e.season===season).every(e=>data.items.some(item=>item.id===e.id&&item.summary?.totals)))));
      const byId = new Map(files.flatMap(file => file.items).map(item => [item.id,item.summary]));
      for (const event of events) if (byId.has(event.id)) event.summary = byId.get(event.id);
    }
    async function getEvent(meta) {
      const event = await read(meta.detail_file,data=>data.id===meta.id&&Array.isArray(data.results));
      return event;
    }
    return {getIndex,ensureStats,getEvent, getEvents:events => Promise.all(events.map(getEvent))};
  }
  site.resultsStore = {create};
})();
