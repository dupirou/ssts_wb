/* Reproducible responsive/PWA acceptance using built real data, no upstream calls. */
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve(process.env.QA_OUT || 'docs/reviews/pr36');
await mkdir(join(out,'screenshots'),{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
async function serve(directory){
  const server=createServer(async(req,res)=>{
    try{
      let path=join(directory,decodeURIComponent(new URL(req.url,'http://localhost').pathname));
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
const report={browser:browser.version(),sizes:[390,768,1440],metrics:[],checks:[]};
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
      data_bytes:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/data/')).reduce((n,e)=>n+e.decodedBodySize,0),
      data_requests:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/data/')).map(e=>new URL(e.name).pathname),
      scroll_width:document.documentElement.scrollWidth,viewport:innerWidth,
    }));
    if(label==='after')assert.ok(metrics.scroll_width<=width,`${path}: overflow ${metrics.scroll_width}/${width}`);
    values.push(metrics);
    if(i===0&&screenshot)await page.screenshot({path:join(out,'screenshots',screenshot),fullPage:!path.includes('/events/')});
    await context.close();
  }
  const median=key=>values.map(v=>v[key]).sort((a,b)=>a-b)[1];
  report.metrics.push({label,path,width,ready_ms:Math.round(median('ready_ms')),nodes:median('nodes'),rows:median('rows'),data_bytes:median('data_bytes'),requests:values[0].data_requests});
}
try{
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
  // Old links and serialized filters restore actual records, not just controls.
  const {context,page}=await pageAt(current.origin,'/history/?season=all&page=2&gender=women&distance=3000',390);
  const ids=await page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event));
  await page.locator('.results-pager button').last().click();
  await page.waitForFunction(()=>!document.querySelector('.results-table[aria-busy]'));
  const saved=page.url();await page.reload();await page.waitForSelector('#app:not([aria-busy])');
  assert.equal(new URL(page.url()).searchParams.get('page'),'3');
  assert.notDeepEqual(await page.locator('.results-table tbody').evaluateAll(es=>es.map(e=>e.dataset.event)),ids);
  await context.close();report.checks.push({name:'legacy filters and pagination',passed:true});
  // Real worker install, complete shell caching, visited deep links and raw evidence offline.
  const pwa=await pageAt(current.origin,'/results/compare/',390,true);
  await pwa.page.evaluate(()=>navigator.serviceWorker.ready);
  await pwa.page.reload();await pwa.page.waitForSelector('#app:not([aria-busy])');
  await pwa.page.locator('.project-toggle').first().click();
  await pwa.page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
  await pwa.context.setOffline(true);
  await pwa.page.reload();await pwa.page.waitForSelector('#app:not([aria-busy])');
  assert.equal(await pwa.page.locator('.compare-project').count(),9);
  await pwa.page.locator('.project-toggle').first().click();
  await pwa.page.waitForFunction(()=>!document.querySelector('#project-detail-0').textContent.includes('正在读取'));
  assert.ok(await pwa.page.locator('#project-detail-0 .review-records li').count()>0);
  report.checks.push({name:'PWA visited deep link and expanded raw records offline',passed:true});
  await pwa.context.close();
  await writeFile(join(out,'performance.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await current.close();await before?.close();}
