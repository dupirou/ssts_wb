// Added to the simulation score per unit of relative time. Fitted by next-round
// advancement Brier score on 15 complete 2023/24–2025/26 World Cup / World Tour stops.
export const advanceFormWeight = { 500: 0.75, 1000: 0.1, 1500: 0.75 };

function relativeTime(time, times) {
  return times.reduce((sum, other) => sum + Math.sign(other - time), 0) / times.length;
}

// Input contains earlier official heats of one station and discipline, in start order.
export function previousRoundForm(heats, distance) {
  const fields = new Map();
  const latest = new Map();
  for (const rows of heats) {
    for (const r of rows) {
      if (r.status !== 'OK' || !(r.time_s > 0) || !r.round_key) continue;
      let field = fields.get(r.round_key);
      if (!field) fields.set(r.round_key, (field = { total: [], closing: [] }));
      field.total.push(r.time_s);
      if (r.last_four_seconds > 0) field.closing.push(r.last_four_seconds);
      latest.set(r.athlete_id, { r, field });
    }
  }
  const form = new Map();
  for (const [id, { r, field }] of latest) {
    const closing = distance === 1500 && r.last_four_seconds > 0;
    form.set(id, closing ? relativeTime(r.last_four_seconds, field.closing) : relativeTime(r.time_s, field.total));
  }
  return form;
}

export function withinHeatForm(active, form) {
  const values = active.map(r => form.get(r.athlete_id) ?? 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map(value => value - mean);
}
