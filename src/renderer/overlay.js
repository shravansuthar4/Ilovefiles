// A translucent ring of formats around the dragged file. The main process streams the cursor
// position; whichever zone is under it turns blue, and releasing the mouse there converts.
const svg = document.getElementById('svg');
const NS = 'http://www.w3.org/2000/svg';
const C = 240;          // centre of the 480×480 window = where the file is
const HOLE = 62;        // the file sits in the hole; letting go there cancels
const GAP = 8;          // px between zones

let zones = [];         // { id, ring: {r1, r2}, a0, a1, el }
let hovered = null;
let identified = false;
let locked = false;     // converting: freeze the highlight

function node(tag, attrs = {}, children = []) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const CORNER = 14;      // corner radius of every zone

const polar = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
const pt = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;

// Annular sector between radii r1..r2 and angles a0..a1 with rounded corners. Its side edges
// run parallel to the radius, GAP/2 inside it, so the gap between zones has constant width.
function sector(r1, r2, a0, a1) {
  const d = GAP / 2;
  const rc = Math.min(CORNER, (r2 - r1) / 2 - 1, (r1 * (a1 - a0)) / 2 - d - 1);

  // Corner on side edge at angle `a` (dir +1 = start edge, -1 = end edge) against the arc of radius R.
  // `outer`: the fillet circle sits inside the outer arc (R - rc); otherwise outside the inner one (R + rc).
  function corner(R, a, dir, outer) {
    const Rc = outer ? R - rc : R + rc;
    const delta = Math.asin((d + rc) / Rc);
    const onArc = polar(R, a + dir * delta);
    const u = [Math.cos(a), Math.sin(a)], n = [-Math.sin(a) * dir, Math.cos(a) * dir];
    const along = Rc * Math.cos(delta);
    const onEdge = [C + along * u[0] + d * n[0], C + along * u[1] + d * n[1]];
    return { onArc, onEdge };
  }

  const os = corner(r2, a0, 1, true), oe = corner(r2, a1, -1, true);
  const is = corner(r1, a0, 1, false), ie = corner(r1, a1, -1, false);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M${pt(os.onArc)}`,
    `A${r2},${r2} 0 ${large} 1 ${pt(oe.onArc)}`,   // outer arc
    `A${rc},${rc} 0 0 1 ${pt(oe.onEdge)}`,         // outer end corner
    `L${pt(ie.onEdge)}`,                            // end edge
    `A${rc},${rc} 0 0 1 ${pt(ie.onArc)}`,          // inner end corner
    `A${r1},${r1} 0 ${large} 0 ${pt(is.onArc)}`,   // inner arc (backwards)
    `A${rc},${rc} 0 0 1 ${pt(is.onEdge)}`,         // inner start corner
    `L${pt(os.onEdge)}`,                            // start edge
    `A${rc},${rc} 0 0 1 ${pt(os.onArc)}`,          // outer start corner
    'Z',
  ].join(' ');
}

// Up to 8 formats form one ring; more are split across an inner and an outer ring.
function layout(items) {
  if (items.length <= 8) return [{ r1: HOLE + 6, r2: 168, font: 17, items }];
  const inner = Math.ceil(items.length / 2);
  return [
    { r1: HOLE + 6, r2: 150, font: 15, items: items.slice(0, inner) },
    { r1: 154, r2: 232, font: 13.5, items: items.slice(inner) },
  ];
}

// One glass shape: frosted body, top sheen, light-catching rim.
const glass = (tag, attrs) => ['glass', 'sheen', 'rim'].map((cls) => node(tag, { ...attrs, class: cls }));

const lens = () => glass('circle', { cx: C, cy: C, r: HOLE - 4 });

function center(children) {
  return node('g', { class: 'center' }, [...lens(), ...children]);
}

function fileLabel({ format, name }) {
  const parts = [];
  if (format) {
    const w = format.length * 7.5 + 14;
    parts.push(node('g', { class: 'badge' }, [
      node('rect', { x: C - w / 2, y: C - 22, width: w, height: 18, rx: 5 }),
      node('text', { x: C, y: C - 13 }, [format]),
    ]));
  }
  if (name) {
    const short = name.length > 16 ? name.slice(0, 7) + '…' + name.slice(-7) : name;
    parts.push(node('text', { x: C, y: C + 12, 'font-size': 11 }, [short]));
  }
  return parts;
}

function render(info) {
  identified = !!info;
  locked = false;
  setHovered(null);
  zones = [];
  svg.replaceChildren();
  if (!info) {
    svg.append(center([node('text', { x: C, y: C, 'font-size': 12 }, ['Move here…'])]));
    return;
  }

  const items = info.targets.map((t) => ({ id: t.id, label: t.label }));
  if (info.moreWithLibreOffice) items.push({ id: 'libreoffice', label: 'More…', hint: true });
  if (!items.length) {
    svg.append(center([...fileLabel(info), node('text', { x: C, y: C + 32, 'font-size': 10, class: 'err' }, ['No conversions'])]));
    return;
  }

  const ring = node('g', { class: 'ring' });
  for (const r of layout(items)) {
    const span = (2 * Math.PI) / r.items.length;
    // First zone centred at the top, then clockwise.
    r.items.forEach((item, i) => {
      const a0 = -Math.PI / 2 - span / 2 + i * span, a1 = a0 + span;
      const mid = (a0 + a1) / 2, rm = (r.r1 + r.r2) / 2;
      const [tx, ty] = polar(rm, mid);
      const el = node('g', { class: `zone${item.hint ? ' hint' : ''}` }, [node('g', {}, [
        ...glass('path', { d: sector(r.r1, r.r2, a0, a1) }),
        node('text', { x: tx, y: ty, 'font-size': item.hint ? 11 : r.font }, [item.label]),
      ])]);
      el.dataset.dx = Math.cos(mid) * 6;
      el.dataset.dy = Math.sin(mid) * 6;
      ring.append(el);
      zones.push({ id: item.id, r1: r.r1, r2: r.r2, a0, a1, el });
    });
  }
  svg.append(ring, center(fileLabel(info)));
}

function zoneAt(x, y) {
  const r = Math.hypot(x - C, y - C);
  let a = Math.atan2(y - C, x - C);
  return zones.find((z) => {
    if (r < z.r1 || r > z.r2) return false;
    let t = a;
    while (t < z.a0) t += 2 * Math.PI;
    while (t >= z.a0 + 2 * Math.PI) t -= 2 * Math.PI;
    return t < z.a1;
  }) || null;
}

function setHovered(zone) {
  const id = zone ? zone.id : null;
  if (id === hovered) return;
  hovered = id;
  for (const z of zones) {
    const hot = z === zone;
    z.el.classList.toggle('hot', hot);
    // The hot zone pops outward a little.
    z.el.firstChild.style.transform = hot ? `translate(${z.el.dataset.dx}px, ${z.el.dataset.dy}px) scale(1.03)` : '';
  }
  window.dc.hover(id);
}

function showStatus({ state, message }) {
  locked = true;
  const hole = svg.querySelector('.center');
  if (!hole) return;
  if (state === 'working') {
    hole.replaceChildren(...lens(),
      node('path', { class: 'spin', d: `M${C},${C - 18} A18,18 0 1 1 ${C - 18},${C}` }));
    return;
  }
  const ok = state === 'done';
  const short = message.length > 22 ? message.slice(0, 21) + '…' : message;
  hole.replaceChildren(...lens(),
    node('text', { x: C, y: C - 12, 'font-size': 22, class: ok ? 'ok' : 'err' }, [ok ? '✓' : '✗']),
    node('text', { x: C, y: C + 14, 'font-size': 10, class: 'status' }, [ok ? short.replace(/^Saved /, '') : short]));
}

window.dc.on('overlay:shown', render);
window.dc.on('overlay:cursor', ({ x, y }) => { if (!locked) setHovered(zoneAt(x, y)); });
window.dc.on('overlay:status', showStatus);

// Where the OS delivers the drag to us (Windows), identify it on entry if needed and accept the drop.
document.addEventListener('dragenter', async (e) => {
  e.preventDefault();
  if (identified) return;
  identified = true;
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  render(await window.dc.targetsForMime(item ? item.type : ''));
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (!locked) setHovered(zoneAt(e.clientX, e.clientY));
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  window.dc.drop([...e.dataTransfer.files].map((f) => window.dc.pathFor(f)).filter(Boolean));
});
