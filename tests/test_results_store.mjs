import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../web/results-store.js',import.meta.url),'utf8');
const create=fetchData=>{const window={};vm.runInNewContext(source,{window});return window.SSTS.resultsStore.create(fetchData);};
test('detail requests are bounded, deduplicated and cached, failed requests retry',async()=>{
  let active=0,max=0,attempts=0,fail=true;
  const store=create(async file=>{
    active++;max=Math.max(max,active);attempts++;
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    if(file==='retry'&&fail){fail=false;throw new Error('offline');}
    return {id:file,results:[]};
  });
  const events=Array.from({length:12},(_,i)=>({id:String(i),detail_file:String(i)}));
  await store.getEvents([...events,...events]);
  assert.equal(attempts,12);assert.equal(max,4);
  await assert.rejects(store.getEvent({id:'retry',detail_file:'retry'}));
  await store.getEvent({id:'retry',detail_file:'retry'});
  assert.equal(attempts,14);
});
test('overview does not request summaries or details; each selected season summary loads once',async()=>{
  const requests=[];
  const store=create(async file=>{
    requests.push(file);
    if(file.endsWith('index.json'))return {schema_version:2,events:[]};
    return {schema_version:2,items:[{id:'a',summary:{totals:{}}},{id:'b',summary:{totals:{}}}]};
  });
  await store.getIndex();await store.getIndex();assert.deepEqual(requests,['results/index.json']);
  const events=[{id:'a',season:'2025/26'},{id:'b',season:'2025/26'}];
  await store.ensureStats(events);await store.ensureStats(events);
  assert.deepEqual(requests,['results/index.json','results/seasons/2025-26.json']);
});

test('invalid schemas and identity mismatches are evicted rather than cached forever',async()=>{
  let valid=false;
  const store=create(async file=>file==='results/index.json'?{schema_version:valid?2:1,events:[]}:{id:valid?'correct':'wrong',results:[]});
  await assert.rejects(store.getIndex());valid=true;await store.getIndex();
  valid=false;await assert.rejects(store.getEvent({id:'correct',detail_file:'detail'}));valid=true;
  assert.equal((await store.getEvent({id:'correct',detail_file:'detail'})).id,'correct');
});
