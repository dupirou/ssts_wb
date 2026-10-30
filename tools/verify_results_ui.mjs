/* Reproducible responsive/PWA acceptance using built real data, no upstream calls. */
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import assert from 'node:assert/strict';
import '../web/results-model.js';
const model=globalThis.SSTS.resultsModel;
const resultIndex=JSON.parse(await readFile(resolve('dist/data/results/index.json'),'utf8'));
const searchIndex=JSON.parse(await readFile(resolve('dist/data/results/search.json'),'utf8'));
for(const event of resultIndex.events)event.search_rows=searchIndex.events.find(e=>e.id===event.id).search_rows;
const out=resolve(process.env.QA_OUT || 'artifacts/ui');
await mkdir(join(out,'screenshots'),{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
async function serve(directory){
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      const api=pathname.match(/^\/api\/v1\/events\/([^/]+)\/(entries|rounds|rankings)$/);
      if(api){
        const data=JSON.parse(await readFile(join(directory,'data/competitions',api[1]+'.json')));
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({schema_version:1,event_id:api[1],resource:api[2],...data[api[2]]}));
        return;
      }
      let path=join(directory,decodeURIComponent(pathname));
      if((await stat(path)).isDirectory())path=join(path,'index.html');
      res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');
      res.end(await readFile(path));
    }catch(_){res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
const current=await serve(resolve('dist'));
const before=process.env.QA_BASELINE?await serve(resolve(process.env.QA_BASELINE)):null;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,headless:true,args:['--no-sandbox']});
const report={browser:browser.version(),sizes:[320,390,768,1440],metrics:[],checks:[]};
async function pageAt(origin,path,width,worker=false){
  const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,serviceWorkers:worker?'allow':'block'});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(origin+path);
  await page.waitForSelector('#app:not([aria-busy])');
  assert.equal(errors.length,0,errors.join('\n'));
  return {context,page};
}
async function measure(origin,path,width,label,screenshot){
  const values=[];
  for(let i=0;i<3;i++){
    const {context,page}=await pageAt(origin,path,width);
    const metrics=await page.evaluate(()=>({
      ready_ms:performance.now(),nodes:document.querySelectorAll('#app *').length,
      rows:document.querySelectorAll('.result-row').length,
      script_bytes:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.endsWith('.js')).reduce((n,e)=>n+e.decodedBodySize,0),
      data_bytes:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/data/')).reduce((n,e)=>n+e.decodedBodySize,0),
      data_requests:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/data/')).map(e=>new URL(e.name).pathname),
      scroll_width:document.documentElement.scrollWidth,viewport:innerWidth,
    }));
    if(label==='after')assert.ok(!metrics.data_requests.some(p=>['/data/results.json','/data/history/index.json'].includes(p)),'No full history feed');
    if(label==='after')assert.ok(metrics.scroll_width<=width,`${path}: overflow ${metrics.scroll_width}/${width}`);
    values.push(metrics);
    if(i===0&&screenshot)await page.screenshot({path:join(out,'screenshots',screenshot),fullPage:!path.includes('/events/')});
    await context.close();
  }
  const median=key=>values.map(v=>v[key]).sort((a,b)=>a-b)[1];
  report.metrics.push({label,path,width,ready_ms:Math.round(median('ready_ms')),nodes:median('nodes'),rows:median('rows'),data_bytes:median('data_bytes'),script_bytes:median('script_bytes'),requests:values[0].data_requests});
}
try{
  // Extend the same server/browser acceptance harness to the non-results routes.
  for(const width of [320,390,430,768,1024,1440]){
    for(const path of ['/','/events/','/athletes/','/events/2026-27/montreal/','/events/2026-27/vancouver/']){
      const {context,page}=await pageAt(current.origin,path,width);
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow: ${path} ${width}`);
      if(path.includes('/montreal/')){
        await page.waitForSelector('.competition-open');
        if(width<1180){
          for(const zone of ['当地','北京']){
            await page.getByRole('button',{name:zone,exact:true}).click();
            const dateOverlap=await page.locator('.match-row:not(.is-past)').evaluateAll(rows=>rows.some(row=>{
              const event=row.querySelector('.event-cell').getBoundingClientRect();
              const round=row.querySelector('.round-cell').getBoundingClientRect();
              return [...row.querySelectorAll('.time .dt:not(.dt-same)')].some(date=>{
                const rect=date.getBoundingClientRect();
                return rect.width>0 && [event,round].some(other=>rect.left<other.right&&rect.right>other.left+1&&rect.top<other.bottom&&rect.bottom>other.top);
              });
            }));
            assert.equal(dateOverlap,false,`Cross-day date overlaps event or round: ${zone} ${width}`);
          }
          const overlap=await page.locator('.match-row:not(.is-past):has(.competition-open)').evaluateAll(rows=>rows.some(row=>{
            const action=row.querySelector('.competition-open').getBoundingClientRect();
            const round=row.querySelector('.round-cell').getBoundingClientRect();
            const heat=row.querySelector('.heat-list:not(:empty)')?.getBoundingClientRect();
            return round.right>action.left+1 || (heat&&action.bottom>heat.top+1);
          }));
          assert.equal(overlap,false,'Round action must fit beside the round and above heat details');
          if(width===320||width===390){
            await page.locator('.match-row:not(.is-past):has(.primary-time .dt:not(.dt-same))').first().scrollIntoViewIfNeeded();
            await page.screenshot({path:join(out,'screenshots','cross-day-'+width+'.png')});
          }
        }
      }
      if(path.includes('/montreal/')&&width<1180){
        // A user can keep the previous JS in HTTP cache during a stylesheet upgrade.
        await page.locator('.heat-list').evaluateAll(lists=>lists.forEach(list=>list.replaceWith(...list.childNodes)));
        for(const scale of ['100%','125%']){
          await page.evaluate(scale=>document.documentElement.style.fontSize=scale,scale);
          const overlapping=await page.locator('.match-row:not(.is-past)').evaluateAll(rows=>rows.some(row=>{
            const heats=[...row.querySelectorAll('.heat')].map(el=>el.getBoundingClientRect());
            return heats.some((r,i)=>i>0&&r.top<heats[i-1].bottom-1);
          }));
          assert.equal(overlapping,false,`Legacy heat rows overlap: ${width} ${scale}`);
        }
        await page.evaluate(()=>document.documentElement.style.fontSize='');
      }
      if(path==='/athletes/'&&width<1180){
        for(const scale of ['100%','125%','150%']){
          await page.evaluate(scale=>document.documentElement.style.fontSize=scale,scale);
          const broken=await page.locator('.directory-rankings dl > div').evaluateAll(items=>items.some(item=>{
            const label=item.querySelector('dt').getBoundingClientRect(),value=item.querySelector('dd').getBoundingClientRect();
            return Math.abs(label.top-value.top)>4||label.right>value.left||item.scrollWidth>item.clientWidth+1;
          }));
          assert.equal(broken,false,`Athlete ranking pair split: ${width} ${scale}`);
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        }
        await page.evaluate(()=>document.documentElement.style.fontSize='');
      }
      if(path==='/events/'){
        const requests=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/data/')).map(e=>new URL(e.name).pathname));
        assert.deepEqual(requests,['/data/calendar.json']);
      }
      if(width===390||width===768)await page.screenshot({path:join(out,'screenshots',path.replaceAll('/','_')+'-'+width+'.png')});
      report.checks.push({name:'site responsive',path,width,passed:true});
      await context.close();
    }
  }
  for(const [path,name] of [['/results/','overview'],['/results/events/','events'],['/results/compare/','compare'],['/results/cycles/milano-2026/?kind=circuit','cycle']]){
    if(before)await measure(before.origin,path,390,'before','before-'+name+'-390.png');
    await measure(current.origin,path,390,'after',name+'-390.png');
  }
  for(const width of report.sizes){
    for(const [path,name] of [['/results/compare/','compare'],['/results/seasons/2025-26/?kind=circuit','season'],['/results/events/','events']]){
      const {context,page}=await pageAt(current.origin,path,width);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow: ${path} ${width}`);
      if(name==='compare'){
        const rect=await page.locator('.compare-table').boundingBox();
        if(width===390)assert.ok(rect.x+rect.width<=390,'Both comparison objects should fit');
        assert.equal(await page.locator('.review-records li').count(),0);
        const overlap=await page.locator('.compare-project').evaluateAll(rows=>rows.some(row=>{const label=row.querySelector('button').getBoundingClientRect();const value=row.querySelector('td').getBoundingClientRect();return label.right>value.x;}));
        assert.equal(overlap,false,'Project labels must not overlap result columns');
        await page.locator('.project-toggle').first().click();
        await page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
        assert.ok(await page.locator('#project-detail-0 .review-records li').count()>0);
        assert.ok(!(await page.locator('#project-detail-0').textContent()).includes('null'));
        await page.screenshot({path:join(out,'screenshots','compare-expanded-'+width+'.png'),fullPage:true});
        await page.getByLabel('第三个对比对象').click();
        await page.locator('[name="third"]').selectOption('2023/24');
        await page.waitForSelector('.compare-table[data-columns="3"]');
        const scroll=page.locator('.compare-scroll');
        await scroll.evaluate(e=>e.scrollLeft=100);
        const sticky=await page.locator('.compare-project th').first().boundingBox();
        const container=await scroll.boundingBox();
        assert.ok(sticky.x>=container.x-1,'Project column must stay fixed');
      }
      if(name==='season'){
        await page.locator('.athlete-contributions summary').click();
        const scroll=page.locator('.contribution-table').locator('..');
        await scroll.evaluate(e=>{e.scrollLeft=100;e.scrollTop=60;});
        const sticky=await page.locator('.contribution-table tbody th').first().boundingBox();
        const container=await scroll.boundingBox();
        assert.ok(sticky.x>=container.x-1,'Athlete column must stay fixed');
      }
      await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});
      await page.screenshot({path:join(out,'screenshots',(name==='compare'?'compare-third':name)+'-'+width+'.png'),fullPage:true});
      report.checks.push({name,path,width,passed:true});
      await context.close();
    }
  }
  // Station acceptance: phone-sized programme cards must be full-width, never a
  // two-column tablet grid. Keep actual browser screenshots as review evidence.
  for (const width of [320,390,430]){
    const path='/events/2026-27/montreal/?day=2026-10-31';
    const {context,page}=await pageAt(current.origin,path,width);
    await page.waitForSelector('.scroll tbody .match-row');
    const layout=await page.locator('.scroll tbody').first().evaluate(el=>{
      const full=el.getBoundingClientRect();
      const cards=[...el.children].filter(child=>child.classList.contains('match-row')).slice(0,6);
      return {full:{x:full.x,width:full.width},cards:cards.map(card=>{
        const r=card.getBoundingClientRect();
        return {x:r.x,width:r.width};
      }),columns:getComputedStyle(el).gridTemplateColumns};
    });
    assert.ok(layout.cards.length>=3,'Montreal programme cards must be present');
    assert.ok(layout.cards.every(card=>Math.abs(card.x-layout.full.x)<=2&&Math.abs(card.width-layout.full.width)<=2),'Mobile schedule cards must be full-width and single-column');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Montreal phone page must not overflow horizontally');
    if(width===390){
      await page.screenshot({path:join(out,'screenshots','montreal-top-390.png'),fullPage:false});
      await page.locator('.schedule-overview > summary').click();
      await page.waitForSelector('.finals-list li');
      const medals=await page.locator('.finals-list').evaluate(el=>{
        const style=getComputedStyle(el);
        return style.display==='flex' && el.scrollWidth>=el.clientWidth &&
          [...el.querySelectorAll(':scope > li')].length>1;
      });
      assert.ok(medals,'Medal overview must retain the shared horizontal strip on phones');
      await page.locator('.finals-list li').first().scrollIntoViewIfNeeded();
      await page.screenshot({path:join(out,'screenshots','montreal-medals-390.png'),fullPage:false});
      await page.locator('.schedule-overview > summary').click();
    }
    await page.locator('.scroll tbody .match-row').first().scrollIntoViewIfNeeded();
    await page.screenshot({path:join(out,'screenshots','montreal-cards-'+width+'.png'),fullPage:false});
    report.checks.push({name:'Montreal mobile programme single column',width,columns:layout.columns,passed:true});
    await context.close();
  }
  // Old links and serialized filters restore actual records, not just controls.
  const {context,page}=await pageAt(current.origin,'/history/?season=all&page=2&gender=women&distance=3000',390);
  const ids=await page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event));
  await page.locator('.results-pager button').last().click();
  await page.waitForFunction(()=>!document.querySelector('.results-table[aria-busy]'));
  const saved=page.url();await page.reload();await page.waitForSelector('#app:not([aria-busy])');
  assert.equal(new URL(page.url()).searchParams.get('page'),'3');
  assert.notDeepEqual(await page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),ids);
  await context.close();report.checks.push({name:'legacy filters and pagination',passed:true});
  // Compare combined-filter page contents with the lightweight index at every requested width.
  const filter=model.resultFilter({athlete:'LI',gender:'women',distance:3000});
  const matched=resultIndex.events.filter(e=>model.eventMatchesResults(e,filter));
  assert.ok(matched.length>4);
  for(const width of report.sizes){
    const filtered=await pageAt(current.origin,'/history/?season=all&athlete=LI&gender=women&distance=3000',width);
    const detailRequests=[];
    filtered.page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/data/'))detailRequests.push(p);});
    assert.deepEqual(await filtered.page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),matched.slice(0,4).map(e=>e.id));
    assert.equal(await filtered.page.getByText('当前筛选无记录',{exact:true}).count(),0);
    await filtered.page.locator('.results-pager button').last().click();
    await filtered.page.waitForFunction(()=>!document.querySelector('.results-table[aria-busy]'));
    assert.deepEqual(await filtered.page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),matched.slice(4,8).map(e=>e.id));
    assert.ok(detailRequests.filter(p=>p.startsWith('/data/results/events/')).length<=4);
    await filtered.page.reload();await filtered.page.waitForSelector('#app:not([aria-busy])');
    assert.deepEqual(await filtered.page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),matched.slice(4,8).map(e=>e.id));
    assert.equal(detailRequests.some(p=>['/data/results.json','/data/history/index.json'].includes(p)),false);
    assert.ok(await filtered.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await filtered.context.close();report.checks.push({name:'exact combined filters and page restore',width,passed:true});
  }
  // Hold the next raw group on real network requests, go back using the store cache,
  // then release the obsolete response. It must not overwrite the current group.
  const racing=await pageAt(current.origin,'/results/compare/?mode=cycle&left=beijing-2022&right=milano-2026&kind=circuit',390);
  const firstSeason=model.scopeEvents(resultIndex,'cycle','beijing-2022','circuit').filter(e=>e.season==='2018/19');
  const heldIds=new Set(firstSeason.slice(3,6).map(e=>e.id));
  let release,blocked;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>blocked=resolve);
  await racing.page.route('**/data/results/events/*.json',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-1).replace(/\.json$/,'');
    if(heldIds.has(id)){blocked();await gate;}
    await route.continue();
  });
  await racing.page.locator('.project-toggle').first().click();
  await racing.page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
  const raw=racing.page.locator('.raw-records').first();
  const originalLinks=await raw.locator('.review-records a:not([target])').evaluateAll(es=>es.map(e=>e.getAttribute('href')));
  await raw.locator('.raw-pager button').last().click();await started;
  await raw.locator('.raw-pager button').first().click();
  await racing.page.waitForFunction(()=>!document.querySelector('.raw-records[aria-busy]'));
  release();await racing.page.waitForLoadState('networkidle');
  assert.deepEqual(await raw.locator('.review-records a:not([target])').evaluateAll(es=>es.map(e=>e.getAttribute('href'))),originalLinks);
  assert.equal(await raw.getByRole('alert').count(),0);
  await racing.context.close();report.checks.push({name:'delayed raw group cannot overwrite cache-restored selection',passed:true});
  // Exact-event comparison: narrow headers, cross-season restoration and a third object.
  const eventIds=['2025-26-worldtour-montreal-1','2025-26-worldtour-montreal-2','2024-25-worldtour-montreal-1'];
  for(const width of report.sizes){
    const path='/results/compare/?mode=event&left='+eventIds[0]+'&right='+eventIds[1];
    const {context,page}=await pageAt(current.origin,path,width);
    assert.equal(await page.locator('[name=left]').inputValue(),eventIds[0]);
    assert.equal(await page.locator('[name=right]').inputValue(),eventIds[1]);
    assert.equal(await page.locator('.field-kind').isVisible(),false);
    assert.equal(await page.locator('.compare-project').count(),9);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(width===390){
      const rect=await page.locator('.compare-table').boundingBox();
      assert.ok(rect.x+rect.width<=390);
    }
    await page.screenshot({path:join(out,'screenshots','event-compare-'+width+'.png'),fullPage:true});
    await page.locator('.project-toggle').first().click();
    await page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
    const links=await page.locator('#project-detail-0 .review-records a:not([target])').evaluateAll(nodes=>nodes.map(node=>node.pathname));
    assert.ok(links.every(link=>eventIds.slice(0,2).some(id=>link.endsWith('/'+id+'/'))));
    await page.getByLabel('第三个对比对象').click();
    await page.locator('[name=third_season]').selectOption('2024/25');
    await page.locator('[name=third]').selectOption(eventIds[2]);
    await page.waitForSelector('.compare-table[data-columns="3"]');
    await page.reload();
    await page.waitForSelector('#app:not([aria-busy])');
    assert.equal(await page.locator('[name=third]').inputValue(),eventIds[2]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(out,'screenshots','event-compare-third-'+width+'.png'),fullPage:true});
    await context.close();
    report.checks.push({name:'exact-event comparison, three objects and reload',width,passed:true});
  }
  // Real worker install, complete shell caching, visited deep links and raw evidence offline.
  const pwa=await pageAt(current.origin,'/results/compare/',390,true);
  await pwa.page.evaluate(()=>navigator.serviceWorker.ready);
  await pwa.page.reload();await pwa.page.waitForSelector('#app:not([aria-busy])');
  await pwa.page.locator('.project-toggle').first().click();
  await pwa.page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
  await pwa.page.goto(current.origin+'/history/?season=all&athlete=LI&gender=women&distance=3000');
  await pwa.page.waitForSelector('#app:not([aria-busy])');
  await pwa.context.setOffline(true);
  await pwa.page.reload();await pwa.page.waitForSelector('#app:not([aria-busy])');
  assert.deepEqual(await pwa.page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),matched.slice(0,4).map(e=>e.id));
  report.checks.push({name:'cached search index, filtered deep link and event rows offline',passed:true});
  await pwa.page.goto(current.origin+'/results/compare/');await pwa.page.waitForSelector('#app:not([aria-busy])');
  assert.equal(await pwa.page.locator('.compare-project').count(),9);
  await pwa.page.locator('.project-toggle').first().click();
  await pwa.page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
  assert.ok(await pwa.page.locator('#project-detail-0 .review-records li').count()>0);
  report.checks.push({name:'PWA visited deep link and expanded raw records offline',passed:true});
  await pwa.context.close();
  await writeFile(join(out,'performance.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await current.close();await before?.close();}
