// Generates the 8 measurement-position illustrations: sitting and lying, bend and straighten, phone on thigh or shin.
// Flat style, ~1.5 px black outlines, basic shapes only. No dependencies: node scripts/gen-illustrations.mjs
//
// Human proportions (side view, thigh = 1.0): shin 0.92, foot 0.6 long, seated trunk 1.13, upper arm 0.72 (0.19 thick),
// forearm 0.58 (0.15 thick), hand 0.42, head 0.55 high. The chair is as high as shin + foot + sole (so the thigh is level), and a
// lying foot is placed by solving the leg geometry so that it rests on the mat. The phone is strapped on (as the app's guide
// says), so the hands rest naturally.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../apps/patient/src/assets/poses/', import.meta.url));
const W = 900, H = 600;
const C = { bg: '#E8F4FC', floor: '#D4E7F6', skin: '#F1D3B8', hair: '#4A3A32', shirt: '#F2A7BE', pants: '#4B505B', pantsFar: '#3B3F49', shoe: '#1B1C20', sole: '#FFFFFF', lace: '#E9EDF2',
  wood: '#E6CB9C', woodFar: '#D2B584', phone: '#FFFFFF', screen: '#8E5BB5', strap: '#2B2F3A', line: '#111111', mat: '#B7D3EC', pillow: '#FFFFFF' };
const SW = 1.5;                                                           // outline width

const T = 190, S = 175;                                                   // thigh, shin (px)
const SOLE = 41;                                                          // ankle centre to the bottom of the sole
const R = { hip: 38, knee: 28, ankle: 15 };                               // thigh underside radius at the hip / at the knee, ankle radius
const THIGH_TOP = [34, 33, 27], THIGH_BOT = [38, 35, 28];                 // thigh radius profile (top / underside), hip -> knee
const SHIN_FRONT = [27, 24, 20, 15], SHIN_BACK = [28, 33, 22, 15];        // shin: calf bulge on the back
const PH = { len: Math.round(0.42 * T), wid: 38 };                        // phone (face-on, screen outward)

const f1 = (n) => Math.round(n * 10) / 10;
const dirOf = (deg) => { const r = (deg * Math.PI) / 180; return [Math.cos(r), -Math.sin(r)]; };   // visual CCW angle -> SVG (y down)
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const anterior = (d) => [d[1], -d[0]];                                    // facing right: the front of a limb is its visual-CCW normal
const lerp = (a, b, t) => a + (b - a) * t;
const prof = (arr, t) => { const x = t * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(x)); return lerp(arr[i], arr[i + 1], x - i); };

function smooth(pts) {                                                     // closed Catmull-Rom spline as cubic Beziers
  const n = pts.length; let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
  }
  return d + 'Z';
}
/** Tapered limb outline between a and b. `front`/`back` are radius profiles on the anterior / posterior side. */
function limb(a, b, front, back, t0 = 0, t1 = 1) {
  const d = norm(sub(b, a)), na = anterior(d), N = 12, fr = [], bk = [];
  for (let i = 0; i <= N; i++) { const t = lerp(t0, t1, i / N), c = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; fr.push(add(c, na, prof(front, t))); bk.push(add(c, na, -prof(back, t))); }
  const cap = (t, k) => { const c = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], rf = prof(front, t), rb = prof(back, t); return add(add(c, na, (rf - rb) / 2), d, k * ((rf + rb) / 2) * 0.95); };
  return smooth([...fr, cap(t1, 1), ...bk.reverse(), cap(t0, -1)]);
}
const disc = (c, r) => `M${f1(c[0] - r)},${f1(c[1])}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;

let uid = 0, scope = '';   // each shape is defined once and reused for the outline pass and the fill pass (halves the file size)
/** Parts of one colour drawn as ONE outlined shape: outline pass first, then fills, so no seams show where parts overlap. */
const union = (paths, fill) => {
  const ids = paths.map(() => `${scope}u${uid++}`);
  return `<defs>${paths.map((d, i) => `<path id="${ids[i]}" d="${d}"/>`).join('')}</defs><g stroke-linejoin="round"><g fill="${C.line}" stroke="${C.line}" stroke-width="${2 * SW}">${ids.map((id) => `<use href="#${id}"/>`).join('')}</g><g fill="${fill}">${ids.map((id) => `<use href="#${id}"/>`).join('')}</g></g>`;
};
const shape = (d, fill) => `<path d="${d}" fill="${fill}" stroke="${C.line}" stroke-width="${SW}" stroke-linejoin="round"/>`;
const circ = (c, r, fill) => `<circle cx="${f1(c[0])}" cy="${f1(c[1])}" r="${r}" fill="${fill}" stroke="${C.line}" stroke-width="${SW}"/>`;
const rrect = (x, y, w, h, r, fill, sw = SW) => `<rect x="${f1(x)}" y="${f1(y)}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${C.line}" stroke-width="${sw}"/>`;
const capsule = (a, b, r, fill) => `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${C.line}" stroke-width="${2 * r + 2 * SW}" stroke-linecap="round"/><line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${fill}" stroke-width="${2 * r}" stroke-linecap="round"/>`;

/** Black low-top sneaker, side view: heel counter, collar, tongue, laces, toe box and a thick white midsole.
 *  `f` = toe direction; the sole faces along g (perpendicular to f). The ankle centre is the origin. */
function shoe(a, f) {
  const g = [-f[1], f[0]], P = (x, y) => add(add(a, f, x), g, y);
  const upper = smooth([[-17, -14], [-27, -2], [-31, 16], [-29, 30], [-4, 31.5], [50, 31.5], [96, 31.5], [108, 26], [108, 17], [96, 8], [72, 3], [48, -2], [28, -8], [14, -15], [2, -17], [-8, -12]].map(([x, y]) => P(x, y)));
  const midsole = smooth([[-30, 29], [-31, 35], [-29, 41], [20, 42], [90, 42], [104, 39], [110, 33], [108, 28], [90, 31], [20, 31]].map(([x, y]) => P(x, y)));
  const laces = [[22, -5, 30, 4], [34, -2, 42, 7], [46, 1, 54, 10]].map(([x1, y1, x2, y2]) => `<path d="M${P(x1, y1).map(f1)}L${P(x2, y2).map(f1)}" stroke="${C.lace}" stroke-width="3" stroke-linecap="round" fill="none"/>`).join('');
  const stripe = smooth([[-14, 20], [10, 12], [38, 14], [14, 23]].map(([x, y]) => P(x, y)));
  const toe = `<path d="M${P(84, 9).map(f1)}Q${P(90, 20).map(f1)} ${P(86, 30).map(f1)}" stroke="#3A3C44" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  return shape(midsole, C.sole) + shape(upper, C.shoe) + toe + laces + `<path d="${stripe}" fill="${C.lace}"/>`;
}

/** Phone seen from its screen side (outer side of the limb), centred at c; local +x is the TOP edge. Two straps cross the limb. */
function phone(c, top, limbWidth) {
  const ang = (Math.atan2(top[1], top[0]) * 180) / Math.PI, L = PH.len, Wd = PH.wid, sw = limbWidth + 8;
  return `<g transform="translate(${f1(c[0])} ${f1(c[1])}) rotate(${f1(ang)})">
    ${rrect(-L / 2, -Wd / 2, L, Wd, 6, C.phone)}
    ${rrect(-L / 2 + 4, -Wd / 2 + 4, L - 8, Wd - 8, 3, C.screen, 1)}
    <rect x="${L / 2 - 12}" y="-7" width="3.5" height="14" rx="1.7" fill="#FFFFFF"/><circle cx="${L / 2 - 10}" cy="-14" r="1.8" fill="#FFFFFF"/>
    ${rrect(-L / 2 + 6, -sw / 2, 8, sw, 2.5, C.strap)}${rrect(L / 2 - 14, -sw / 2, 8, sw, 2.5, C.strap)}
  </g>`;
}

/** Arm with given joints (shoulder, elbow, wrist): skin arm with a simple hand (narrow wrist, wider back of the hand, tapering rounded
 *  fingers), then a short rounded sleeve over the top half. */
function armAt(shoulder, elbow, wrist) {
  const ud = norm(sub(elbow, shoulder)), hd = norm(sub(wrist, elbow)), hn = [-hd[1], hd[0]];
  const Q = (x, y) => add(add(wrist, hd, x), hn, y);
  const hand = smooth([[-8, -9], [6, -12], [22, -15], [40, -14], [56, -11], [68, -8], [77, -3], [78, 3], [72, 8], [60, 10], [44, 12], [27, 14], [9, 13], [-8, 9]].map(([x, y]) => Q(x, y)));
  const skin = union([limb(shoulder, elbow, [17, 17, 15], [17, 17, 15]), limb(elbow, wrist, [14, 13, 10], [14, 13, 10]), hand], C.skin);
  const fingers = [[56, -3, 76, -1], [54, 4, 74, 5]].map(([x1, y1, x2, y2]) => `<path d="M${Q(x1, y1).map(f1)}L${Q(x2, y2).map(f1)}" stroke="#B98F72" stroke-width="1.3" stroke-linecap="round" fill="none"/>`).join('');
  return skin + fingers + capsule(add(shoulder, ud, -2), add(shoulder, ud, 0.55 * Math.hypot(...sub(elbow, shoulder))), 21, C.shirt);
}

/** Faceless head in side view: neck, skull, hair, nose. `up` = toward the top of the head, `face` = the way the person looks. */
function head(neckBase, up, face, id) {
  const c = add(neckBase, up, 56), P = (x, y) => add(add(c, face, x), up, y);
  const hair = shape(smooth([P(-46, -6), P(-42, 30), P(-8, 52), P(26, 42), P(42, 16), P(12, 12), P(-20, -4)]), C.hair);
  return `${union([limb(add(neckBase, up, -10), add(neckBase, up, 26), [13, 13], [14, 14]), disc(c, 40), disc(P(40, -2), 5)], C.skin)}
    <clipPath id="${id}"><circle cx="${f1(c[0])}" cy="${f1(c[1])}" r="40"/></clipPath><g clip-path="url(#${id})">${hair}</g>`;
}

function chair(seatTop, floorY, kneeX, hipX) {
  const left = hipX - 70, right = kneeX + 18, leg = (x, far) => rrect(x, seatTop, 11, floorY - seatTop, 3, far ? C.woodFar : C.wood);
  return leg(left + 4, true) + leg(right - 28, true) + rrect(left, seatTop - 215, 11, 233, 4, C.wood) + rrect(left - 3, seatTop - 215, 54, 14, 5, C.wood)
    + rrect(left, seatTop - 2, right - left, 18, 6, C.wood) + leg(left + 18, false) + leg(right - 14, false);
}

/** Thigh angle (degrees above horizontal) for which, with the given knee flexion, the foot lies flat on the mat (heel slide). */
function liftedThigh(flex, hipH, ankleH) {
  const f = (th) => hipH + T * Math.sin((th * Math.PI) / 180) - S * Math.sin(((flex - th) * Math.PI) / 180) - ankleH;
  let lo = 15, hi = 85; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}

const nearLeg = (hip, knee, ankle, dT, extra = []) => [
  ...extra,
  limb(hip, knee, THIGH_TOP, THIGH_BOT),
  disc(add(knee, anterior(dT), 2), R.knee + 2),                              // rounded knee
  limb(knee, ankle, SHIN_FRONT, SHIN_BACK),
];

function scene({ pose, bend, phoneOn }) {
  uid = 0; scope = `${pose[0]}${bend ? 'f' : 'e'}${phoneOn[0]}-`;            // unique ids per picture, safe to embed inline
  const sitting = pose === 'sitting', FLEX = sitting ? 105 : 118, clip = `skull-${scope}`;
  let hip, knee, ankle, dT, dS, footF, parts;
  if (sitting) {
    const floorY = 566, seatTop = 387;                                       // chair height = shin + foot + sole, so the thigh is level
    dT = dirOf(-3); dS = bend ? dirOf(-3 - FLEX) : dirOf(7);
    hip = [bend ? 368 : 271, seatTop - R.hip]; knee = add(hip, dT, T); ankle = add(knee, dS, S);
    footF = bend ? [1, 0] : norm([0.35, -0.94]);
    const X = (x, y) => [hip[0] + x, hip[1] - y];                            // body coordinates: x forward, y up from the hip joint
    const kL = [knee[0] + 24, knee[1] - 2], aL = [kL[0] - 18, floorY - SOLE];  // left leg: bent, a little in front so it shows
    const far = shoe(aL, [1, 0]) + union([limb(hip, kL, [R.hip - 4, R.knee], [R.hip, R.knee]), limb(kL, aL, SHIN_FRONT, SHIN_BACK)], C.pantsFar);
    // trunk: S-curved back, chest and waist (not a slab)
    const trunk = shape(smooth([X(-46, 30), X(-46, 70), X(-51, 122), X(-58, 176), X(-50, 214), X(-30, 229), X(-2, 233), X(18, 226), X(40, 206), X(52, 166), X(51, 122), X(43, 76), X(42, 32)]), C.shirt);
    // pants: buttock bump flowing into the thigh, one outlined shape with the leg
    const pelvis = smooth([X(-46, 48), X(-60, 24), X(-64, -6), X(-52, -30), X(-24, -38), X(14, -38), X(46, -34), X(50, -4), X(47, 30), X(42, 50)]);
    const near = union(nearLeg(hip, knee, ankle, dT, [pelvis]), C.pants);
    const bgFront = `<rect width="${W}" height="${H}" fill="${C.bg}"/><rect y="${floorY}" width="${W}" height="${H - floorY}" fill="${C.floor}"/>` + chair(seatTop, floorY, knee[0], hip[0]);
    const arm = armAt(X(-2, 192), X(-6, 56), X(98, 46));                     // upper arm hangs, forearm rests on the thigh
    parts = bgFront + far + trunk + head(X(-6, 230), [0, -1], [1, 0], clip) + shoe(ankle, footF) + near + arm;
  } else {
    const matTop = 470, mat = 26;
    hip = [405, matTop - R.hip];
    const th = bend ? liftedThigh(FLEX, R.hip, SOLE) : -3;
    dT = dirOf(th); knee = add(hip, dT, T);
    dS = bend ? dirOf(th - FLEX) : dirOf(-2); ankle = add(knee, dS, S); footF = bend ? [1, 0] : norm([0.4, -0.92]);
    const fk = [hip[0] + T, matTop - R.knee], fa = [fk[0] + S, matTop - R.ankle - 2];                     // left leg lies straight behind
    const far = shoe(add(fa, [14, 0]), norm([0.4, -0.92])) + union([limb([hip[0] + 8, hip[1] + 2], fk, [R.hip, R.knee], [R.hip, R.knee]), limb(fk, fa, [R.knee, 20, R.ankle], [R.knee, 22, R.ankle])], C.pantsFar);
    const sx = hip[0] - 215;                                                                                // shoulder x
    const trunk = shape(smooth([[hip[0] + 6, matTop - 4], [hip[0] - 90, matTop - 2], [sx - 6, matTop - 3], [sx - 20, matTop - 58], [sx - 4, matTop - 112], [sx + 50, matTop - 118], [hip[0] - 100, matTop - 100], [hip[0] - 10, matTop - 86], [hip[0] + 10, matTop - 70]]), C.shirt);
    const lyingHead = rrect(sx - 120, matTop - 26, 126, 26, 12, C.pillow) + head([sx - 16, matTop - 64], [-1, 0], [0, -1], clip);
    const pelvis = smooth([[hip[0] - 50, matTop - 6], [hip[0] - 54, matTop - 62], [hip[0] - 4, matTop - 84], [hip[0] + 34, matTop - 52], [hip[0] + 30, matTop - 6]]);
    const near = union(nearLeg(hip, knee, ankle, dT, [pelvis]), C.pants);
    const bg = `<rect width="${W}" height="${H}" fill="${C.bg}"/><rect y="${matTop + mat}" width="${W}" height="${H - matTop - mat}" fill="${C.floor}"/>` + rrect(30, matTop, W - 60, mat, 12, C.mat);
    parts = bg + far + lyingHead + trunk + shoe(ankle, footF) + near + armAt([sx + 6, matTop - 56], [sx + 6 + 128, matTop - 30], [hip[0] + 6, matTop - 27]);
  }
  const pc = phoneOn === 'thigh' ? add(knee, dT, -(10 + PH.len / 2)) : add(knee, dS, 10 + PH.len / 2);
  parts += phone(pc, phoneOn === 'thigh' ? dT : dS, phoneOn === 'thigh' ? 2 * R.knee + 6 : 2 * 26);
  const title = `${sitting ? 'Sitting on a chair' : 'Lying on your back'}, ${bend ? 'knee bent' : 'leg straight'}, phone strapped on the ${phoneOn} with its top edge toward the ${phoneOn === 'thigh' ? 'knee' : 'ankle'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><title>${title}</title>\n${parts}\n</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
for (const pose of ['sitting', 'lying'])
  for (const [name, bend, on] of [['flex-thigh', true, 'thigh'], ['flex-shin', true, 'shin'], ['ext-thigh', false, 'thigh'], ['ext-shin', false, 'shin']])
    writeFileSync(`${OUT}${pose}-${name}.svg`, scene({ pose, bend, phoneOn: on }));
console.log('wrote 8 illustrations to', OUT);
