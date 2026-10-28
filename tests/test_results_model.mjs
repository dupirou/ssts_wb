import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import '../web/results-model.js';
const m=globalThis.SSTS.resultsModel;
const file=async name=>JSON.parse(await readFile(new URL('../'+name,import.meta.url),'utf8'));
const data=await file('dist/data/results.json');
const index=await file('dist/data/results/index.json');
// Frozen pre-refactor calculation, tested against every real event and aggregate scope.
function baseline(events){
  const rows=events.flatMap(e=>e.results).filter(r=>r.medal_eligible!==false);
  const starts=rows.filter(r=>r.status!=='DNS'&&r.started!==false);
  const medal=r=>r.medal_eligible!==false&&r.medal_verified!==false&&r.status==='classified'&&r.rank!=null&&r.rank>=1&&r.rank<=3&&(r.rank_scope!=='final'||r.final_group==='A');
  return {events:events.length,entries:rows.length,starts:starts.length,
    medals:[1,2,3].map(rank=>rows.filter(r=>medal(r)&&r.rank===rank).length),
    a_finals:starts.filter(r=>r.final_group==='A').length,
    top8:rows.filter(r=>r.status==='classified'&&r.rank>=1&&r.rank<=8&&(r.rank_scope!=='final'||r.final_group==='A')).length};
}
test('all real event/season/cycle metrics agree with pre-refactor statistics',()=>{
  const groups=[...data.events.map(e=>[e]),...[...new Set(data.events.map(e=>e.season))].map(s=>data.events.filter(e=>e.season===s)),...data.cycles.map(c=>data.events.filter(e=>c.seasons.includes(e.season)))];
  for(const events of groups){
    assert.deepEqual(m.statistics(events),baseline(events));
    assert.deepEqual(m.statistics(events.map(e=>({...e,results:undefined,summary:m.summarize(e)}))),baseline(events));
    for(const key of m.projectKeys){
      const expected=baseline(events.map(e=>({results:e.results.filter(r=>m.matchesProject(r,key))})));
      expected.events=0;
      assert.deepEqual(m.projectSummary(events,key).totals,expected);
    }
    assert.deepEqual(m.athleteStatistics(events.map(e=>({...e,summary:m.summarize(e)}))),m.athleteStatistics(events));
  }
});
test('comparison best rank uses official overall classification, never final-heat place',()=>{
  const base={gender:'women',distance_m:3000,format:'relay',name:'China',status:'classified',medal_eligible:true};
  const group={...base,rank:1,rank_scope:'final',final_group:'A',classification_missing:true};
  const classified={...base,rank:8,rank_scope:'overall',final_group:'B'};
  const key=['women',3000];
  const onlyHeats=m.projectSummary([{results:[group],coverage:'partial'}],key);
  assert.equal(onlyHeats.best,null,'heat winner has no verified final classification');
  assert.equal(onlyHeats.totals.entries,1,'raw race record remains present');
  const combined=m.projectSummary([{results:[group],coverage:'partial'},{results:[classified],coverage:'complete'}],key);
  assert.equal(combined.best.rank,8,'A-final first place must not outrank overall eighth');
  assert.equal(combined.best.rank_scope,'overall');
  const falselyOverall={...group,rank_scope:'overall'};
  assert.equal(m.projectSummary([{results:[falselyOverall],coverage:'partial'}],key).best,null,
    'classification_missing is never a valid overall best rank');
});
test('partial catalogue cannot assert not offered or zero from imported subset',()=>{
  const event={official_event_id:'1',season:'2020/21',kind:'worlds',coverage:'complete',programme:[],results:[]};
  const fixture={cycles:[],events:[event],inventory:[{season:'2020/21',kind:'worlds',official_event_ids:['1','2']}],pending:[]};
  const scope=m.scopeCoverage(fixture,'season','2020/21','worlds',[event]);
  assert.equal(scope.partial,true);
  assert.equal(m.projectSummary([event],['mixed',2000],scope).state,'uncollected');
  fixture.inventory[0].official_event_ids=['1'];
  const complete=m.scopeCoverage(fixture,'season','2020/21','worlds',[event]);
  assert.equal(complete.partial,false);
  assert.equal(m.projectSummary([event],['mixed',2000],complete).state,'not_offered');
  event.programme=[{gender:'mixed',distance_m:2000,format:'relay'}];
  assert.equal(m.projectSummary([event],['mixed',2000],complete).state,'zero');
  event.results=[{gender:'mixed',distance_m:2000,format:'relay',rank:null,status:'classified',classification_missing:true}];
  assert.equal(m.projectSummary([event],['mixed',2000],scope).missing_classifications,true);
});
test('unknown inventories, future seasons and empty verified inventories stay distinct',()=>{
  const fixture={cycles:[{id:'future',seasons:['2026/27','2027/28']}],events:[],inventory:[],pending:[]};
  assert.equal(m.scopeCoverage(fixture,'cycle','future','worlds',[]).state,'uncollected');
  fixture.inventory=[{season:'2020/21',kind:'worldcup',official_event_ids:[]}];
  assert.equal(m.scopeCoverage(fixture,'season','2020/21','circuit',[]).state,'not_offered');
});
test('confirmed scope excludes all around/super 3000 and keeps relay without lineup',()=>{
  const row={gender:'men',format:'individual',rank:1,status:'classified',final_group:'A'};
  const stats=m.statistics([{results:[{...row,distance_m:0},{...row,distance_m:3000},{...row,format:'relay',distance_m:5000}]}]);
  assert.deepEqual(stats.medals,[1,0,0]);
  assert.equal(stats.entries,1);
});
test('built index contains no result rows or source document blobs; shards preserve all evidence',async()=>{
  assert.equal(index.schema_version,2);
  assert.equal(index.events.length,data.events.length);
  for(const meta of index.events){
    assert.equal(meta.results,undefined);
    assert.equal(meta.summary,undefined);
    assert.equal(meta.source.documents,undefined);
    const detail=await file('dist/data/'+meta.detail_file);
    const original=data.events.find(e=>e.id===meta.id);
    assert.deepEqual(detail.results,original.results);
    assert.deepEqual(detail.source,original.source);
  }
  const baselineBytes=Buffer.byteLength(JSON.stringify(data));
  const indexBytes=Buffer.byteLength(JSON.stringify(index));
  assert.ok(indexBytes<baselineBytes*.2,`${indexBytes}/${baselineBytes}`);
});
