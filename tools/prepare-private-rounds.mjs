// Run before Wrangler bundles the Worker. Forecasts stay outside the public assets directory.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { report } from '../src/private-analysis.mjs';

const dist = new URL('../dist/', import.meta.url);
const output = new URL('../build/private-worker.mjs', import.meta.url);
const readAsset = path => readFile(new URL('.' + path, dist), 'utf8');
const env = { ASSETS: { async fetch(url) {
  try {
    return new Response(await readAsset(url.pathname));
  } catch (error) {
    if (error.code === 'ENOENT') return new Response(null, { status: 404 });
    throw error;
  }
} } };

const day = new Date().toISOString().slice(0, 10);
const { stations } = JSON.parse(await readAsset('/data/calendar.json'));
const rounds = {};
for (const station of stations.filter(s => s.date_end >= day)) {
  const { items } = JSON.parse(await readAsset('/data/competitions/' + station.id + '/rounds.json'));
  for (const heat of items) {
    if (heat.evidence !== 'official_start_list' || heat.format !== 'individual' || heat.local_date < day) continue;
    const args = [heat.gender, heat.distance_m, heat.round_key];
    const key = JSON.stringify(args);
    if (Object.hasOwn(rounds, key)) continue;
    const groups = await report(env, ...args);
    if (groups.length) rounds[key] = groups;
  }
}
const source = "import { createWorker } from '../src/worker.mjs';\n" +
  'export default createWorker(' + JSON.stringify({ day, rounds }) + ');\n';
await mkdir(new URL('.', output), { recursive: true });
const temp = new URL(output.href + '.tmp');
await writeFile(temp, source);
await rename(temp, output);
console.log('Prepared private predictions for', Object.keys(rounds).length, 'rounds.');
