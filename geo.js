// Pure helpers for routing and guidance. No DOM access.
const R_EARTH = 6371000;
const rad = d => d * Math.PI / 180;

function hav(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(x));
}

// route: an OSRM route object with geojson geometry and steps
function buildRoute(r) {
  const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + hav(coords[i - 1], coords[i]);
  const steps = r.legs.flatMap(l => l.steps);
  const starts = [];
  let s = 0;
  for (const st of steps) { starts.push(s); s += st.distance; }
  const total = cum[cum.length - 1];
  return {
    coords, cum, total, steps, starts,
    distance: r.distance, duration: r.duration,
    scale: total > 0 ? r.distance / total : 1
  };
}

// Nearest point on the route. Search starts at fromIdx for speed.
function project(route, p, fromIdx) {
  const run = (lo) => {
    let best = { d: Infinity, along: 0, idx: lo };
    const k = Math.cos(rad(p[0]));
    for (let i = lo; i < route.coords.length - 1; i++) {
      const a = route.coords[i], b = route.coords[i + 1];
      const ax = (a[1] - p[1]) * k * 111320, ay = (a[0] - p[0]) * 110540;
      const bx = (b[1] - p[1]) * k * 111320, by = (b[0] - p[0]) * 110540;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) {
        best = { d, along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]), idx: i };
      }
    }
    return best;
  };
  const near = run(Math.max(0, (fromIdx || 0) - 20));
  return near.d < 60 ? near : run(0);
}

function pointAt(route, along) {
  const a = Math.max(0, Math.min(route.total, along));
  let lo = 0, hi = route.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route.cum[mid] <= a) lo = mid; else hi = mid;
  }
  const seg = route.cum[hi] - route.cum[lo];
  const t = seg ? (a - route.cum[lo]) / seg : 0;
  const p = route.coords[lo], q = route.coords[hi];
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

function stepIndex(route, alongScaled) {
  let i = 0;
  while (i + 1 < route.starts.length && route.starts[i + 1] <= alongScaled) i++;
  return i;
}

function bearingName(b) {
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return names[Math.round(((b % 360) + 360) % 360 / 45) % 8];
}

function side(mod) {
  if (!mod) return '';
  return mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : '';
}

function describe(step) {
  if (step.text) return step.text;
  const m = step.maneuver || {}, t = m.type, mod = m.modifier, name = step.name || '';
  const on = name ? ' onto ' + name : '';
  switch (t) {
    case 'depart': return 'Head ' + bearingName(m.bearing_after || 0) + (name ? ' on ' + name : '');
    case 'arrive': return 'You have arrived at your destination' + (side(mod) ? ', on the ' + side(mod) : '');
    case 'turn':
      if (mod === 'uturn') return 'Make a U-turn';
      if (mod === 'straight') return 'Continue straight' + on;
      return 'Turn ' + (mod || '') + on;
    case 'new name': return 'Continue' + on;
    case 'continue':
      if (mod === 'uturn') return 'Make a U-turn';
      return 'Continue' + (mod && mod !== 'straight' ? ' ' + mod : ' straight') + on;
    case 'merge': return 'Merge' + (mod ? ' ' + mod : '') + on;
    case 'on ramp': case 'off ramp':
      return 'Take the ramp' + (side(mod) ? ' on the ' + side(mod) : '') + on;
    case 'fork': return 'Keep ' + (side(mod) || 'straight') + ' at the fork' + on;
    case 'end of road': return 'Turn ' + (mod || '') + ' at the end of the road' + on;
    case 'roundabout': case 'rotary':
      return 'At the roundabout, ' + (m.exit ? 'take exit ' + m.exit : 'continue') + on;
    case 'roundabout turn': return 'At the roundabout, turn ' + (mod || '') + on;
    case 'exit roundabout': case 'exit rotary': return 'Exit the roundabout' + on;
    default: return 'Continue' + on;
  }
}

function fmtDist(m) {
  if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

function fmtTime(s) {
  const min = Math.round(s / 60);
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}


// Points along the great circle from a to b, longitudes unwrapped so the line never jumps.
function gcPoints(a, b, n) {
  const p1 = rad(a[0]), l1 = rad(a[1]), p2 = rad(b[0]), l2 = rad(b[1]);
  const d = hav(a, b) / R_EARTH;
  if (d === 0) return [a, b];
  const out = [];
  let prevLon = a[1];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    const lat = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
    let lon = Math.atan2(y, x) * 180 / Math.PI;
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    out.push([lat, lon]);
  }
  return out;
}

const FLIGHT_KMH = 800;

// OSRM-shaped route object for a direct flight.
function flightRoute(from, to) {
  const dist = hav(from, to);
  const n = Math.min(400, Math.max(2, Math.ceil(dist / 25000)));
  const pts = gcPoints(from, to, n);
  return {
    geometry: { coordinates: pts.map(p => [p[1], p[0]]) },
    distance: dist,
    duration: dist / (FLIGHT_KMH / 3.6),
    legs: [{ steps: [
      { distance: dist, name: '', text: 'Fly direct to your destination', maneuver: { type: 'depart' } },
      { distance: 0, name: '', maneuver: { type: 'arrive' } }
    ] }]
  };
}

// Convert a GraphHopper (OpenRailRouting) path into an OSRM-shaped route object.
function railRoute(path) {
  const steps = [];
  const ins = path.instructions || [];
  ins.forEach((i, k) => {
    const name = i.street_name || '';
    if (i.sign === 4 || k === ins.length - 1 && i.distance === 0) {
      steps.push({ distance: 0, name: '', maneuver: { type: 'arrive' } });
      return;
    }
    const last = steps[steps.length - 1];
    if (last && last.name === name && last.maneuver.type !== 'arrive' && k > 0) {
      last.distance += i.distance;
    } else {
      steps.push({
        distance: i.distance, name,
        text: k === 0 ? 'Join the railway at the nearest track' : (name ? 'Follow ' + name : 'Continue on the railway'),
        maneuver: { type: 'continue' }
      });
    }
  });
  if (!steps.length || steps[steps.length - 1].maneuver.type !== 'arrive') {
    steps.push({ distance: 0, name: '', maneuver: { type: 'arrive' } });
  }
  return {
    geometry: { coordinates: path.points.coordinates },
    distance: path.distance,
    duration: path.time / 1000,
    legs: [{ steps }]
  };
}

// Compass bearing in degrees from a to b ([lat, lon] pairs).
function bearing(a, b) {
  const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Arrow symbol that matches the instruction, as seen from the traveler's direction of travel.
function arrowFor(step) {
  const m = step.maneuver || {}, t = m.type, mod = m.modifier || '';
  if (t === 'arrive') return '\u2691';
  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') return '\u27F3';
  if (mod === 'uturn') return '\u21B6';
  const map = { 'sharp left': '\u2199', 'left': '\u2190', 'slight left': '\u2196', 'straight': '\u2191',
    'slight right': '\u2197', 'right': '\u2192', 'sharp right': '\u2198' };
  return map[mod] || '\u2191';
}

const GEO = { bearing, arrowFor, gcPoints, flightRoute, railRoute, FLIGHT_KMH, hav, buildRoute, project, pointAt, stepIndex, describe, fmtDist, fmtTime, bearingName };
if (typeof module !== 'undefined') module.exports = GEO;
