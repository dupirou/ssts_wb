/* Compile browser projections with the exact same pure model used by every results page. */
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import '../web/results-model.js';
const model = globalThis.SSTS.resultsModel;
const out = resolve(process.argv[2] || 'dist');
const catalog = JSON.parse(await readFile(resolve(out,'data/results.json'),'utf8'));
const target = resolve(out,'data/results');
await rm(target,{recursive:true,force:true});
await mkdir(resolve(target,'events'),{recursive:true});
await mkdir(resolve(target,'seasons'),{recursive:true});
const write = (path,value) => writeFile(resolve(target,path),JSON.stringify(value) + '\n');
const seasons = new Map();
const events = [];
const athletesById = new Map(catalog.athletes.map(person=>[person.id,person]));
for (const event of catalog.events) {
  const {results,...meta} = event;
  const detail_file = 'results/events/' + event.id + '.json';
  await write('events/' + event.id + '.json',{schema_version:2,...event});
  const search_text = [...new Set(results.flatMap(r=>[r.name,...(athletesById.get(r.athlete_id)?.aliases||[]),...(r.members||[]).flatMap(m=>[m.name,...(athletesById.get(m.athlete_id)?.aliases||[])])]))].join(' ').toLocaleLowerCase();
  const programme=meta.programme?.map(({gender,distance_m,format,official_result_id})=>({gender,distance_m,format,official_result_id})) ?? null;
  events.push({...meta,programme,source:{url:meta.source.url,kind:meta.source.kind},record_count:results.length,search_text,detail_file});
  if (!seasons.has(event.season)) seasons.set(event.season,[]);
  seasons.get(event.season).push({id:event.id,summary:model.summarize(event)});
}
for (const [season,items] of seasons) await write('seasons/' + season.replace('/','-') + '.json',{schema_version:2,season,items});
const inventory = catalog.inventory.map(({season,kind,official_event_ids}) => ({season,kind,official_event_ids}));
await write('index.json',{...catalog,schema_version:2,current_season:process.argv[3],events,inventory});
