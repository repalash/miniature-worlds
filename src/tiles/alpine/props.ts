import {BufferAttribute, BufferGeometry, Matrix4, Shape, Vector3} from 'threepipe'
import {box, cylinder, extrudeSoft, softBox} from '../../kit/geo'
import {TintBatch} from '../../kit/batch'
import {rng} from '../../kit/noise'
import type {GroundPath} from '../../kit/path'
import type {AlpineMaterials} from './materials'

/**
 * Built props of the alpine pass, all procedural: the stone arch bridge over the gorge (arch stones in courses,
 * rubble spandrels and abutments, a parapet with granite copings, the gravel deck), snow poles and timber rails
 * along the road, a yellow hiking signpost, a cairn on the saddle, and the herdsman's hut on the cirque bench
 * (rubble ground floor, larch upper floor, shingle roof weighed down with stones, shutters, a bench, a woodpile).
 */

/** A frame: origin, the u (along) and v (across) axes in xz; matrices from local (u, y, v) coordinates. */
export class Frame {
    readonly m: Matrix4
    constructor(readonly o: Vector3, readonly yaw: number) {
        this.m = new Matrix4().makeRotationY(yaw).setPosition(o)
    }
    /** Local (u, y, v) -> matrix of a piece placed there, turned by `ry` about its own y and tilted by `rz` about v. */
    at(u: number, y: number, v: number, ry = 0, rz = 0) {
        const l = new Matrix4().makeRotationY(ry).multiply(new Matrix4().makeRotationZ(rz)).setPosition(u, y, v)
        return this.m.clone().multiply(l)
    }
    point(u: number, y: number, v: number) {
        return new Vector3(u, y, v).applyMatrix4(this.m)
    }
}

const tone = (r: () => number, a = 0.82, b = 1.12): [number, number, number] => {
    const k = a + (b - a) * r()
    return [k * (0.97 + 0.06 * r()), k, k * (0.96 + 0.05 * r())]
}

export interface BridgeOptions {
    /** Centre of the deck (road surface) and the road direction (unit, xz). */
    center: Vector3
    dir: Vector3
    span?: number
    rise?: number
    width?: number
    /** Length of the bridge between its parapet ends. */
    length?: number
}

/** The stone arch bridge. Returns its frame and the springing height (for the views). */
export function buildBridge(batch: TintBatch, m: AlpineMaterials, o: BridgeOptions) {
    const r = rng(41)
    const yaw = Math.atan2(-o.dir.z, o.dir.x)
    const F = new Frame(o.center, yaw)
    const span = o.span ?? 5.4, f = o.rise ?? 2.0, W = o.width ?? 4.4, L = o.length ?? 11
    const deck = 0
    const ring = 0.55, crown = 0.45
    const yS = deck - crown - ring - f
    const R = (span * span / 4 + f * f) / (2 * f)
    const cy = yS + f - R
    const th0 = Math.asin((yS - cy) / R)
    const arc = R * (Math.PI - 2 * th0)
    const nR = Math.max(9, Math.round(arc / 0.42)) | 1
    // arch stones: courses across the barrel, joints staggered; the face stones longer and proud
    for (let k = 0; k < nR; k++) {
        const a0 = th0 + (Math.PI - 2 * th0) * k / nR, a1 = th0 + (Math.PI - 2 * th0) * (k + 1) / nR
        const a = (a0 + a1) / 2
        const thick = R * (a1 - a0) - 0.025
        const key = k === (nR - 1) / 2
        const depth = ring * (key ? 1.18 : 1) * (0.95 + 0.1 * r())
        const rc = R + depth / 2
        const u = Math.cos(a) * rc, y = cy + Math.sin(a) * rc
        let v = -W / 2
        const stagger = k % 2 ? 0.35 : 0
        const pieces: number[] = []
        let rem = W
        let first = 0.75 + stagger
        while (rem > 0.01) {
            const len = Math.min(rem, pieces.length === 0 ? first : 0.55 + 0.4 * r())
            pieces.push(rem - len < 0.3 ? rem : len)
            rem -= pieces[pieces.length - 1]
            first = 0
        }
        for (const len of pieces) {
            const c = v + len / 2
            const face = Math.abs(c) + len / 2 > W / 2 - 0.05
            const g = softBox(depth + (face ? 0.04 : 0), thick, len - 0.02, 0.035, 1)
            batch.add(m.granite, g, F.at(u, y, c, 0, a), tone(r, 0.8, 1.15))
            v += len
        }
    }
    // spandrels and abutments: rubble, the arch's extrados cut out
    const Re = R + ring
    const ue = Math.sqrt(Math.max(0, Re * Re - (yS - cy) ** 2))
    const a = L / 2
    const y0 = yS - 2.5
    const s = new Shape()
    s.moveTo(-a, y0)
    s.lineTo(-ue - 0.01, y0)
    s.lineTo(-ue - 0.01, yS)
    s.absarc(0, cy, Re, Math.PI - th0, th0, true)
    s.lineTo(ue + 0.01, y0)
    s.lineTo(a, y0)
    s.lineTo(a, deck - 0.08)
    s.lineTo(-a, deck - 0.08)
    s.lineTo(-a, y0)
    const sp = extrudeSoft(s, W - 0.08, 0.04, 24, 1)
    batch.add(m.rubble, sp, F.at(0, 0, -(W - 0.08) / 2))
    // abutment footings stepping into the gorge walls
    for (const side of [-1, 1]) {
        batch.add(m.rubble, softBox(1.6, 2.2, W + 0.5, 0.08, 1), F.at(side * (ue + 0.6), yS - 1.4, 0))
    }
    // deck
    batch.add(m.gravel, box(L, 0.3, W - 0.86), F.at(0, deck - 0.17, 0))
    // parapets: rubble, granite copings (snow on them), flared at the ends
    const parH = 0.55, parT = 0.42
    for (const side of [-1, 1]) {
        const v = side * (W / 2 - parT / 2)
        batch.add(m.rubble, softBox(L, parH, parT, 0.05, 1), F.at(0, deck + parH / 2 - 0.05, v))
        for (let u = -a; u < a - 0.01;) {
            const len = Math.min(a - u, 0.7 + 0.4 * r())
            batch.add(m.granite, softBox(len - 0.02, 0.15, parT + 0.08, 0.035, 1), F.at(u + len / 2, deck + parH + 0.02, v), tone(r, 0.85, 1.1))
            u += len
        }
        for (const end of [-1, 1]) {
            // flared wing: turned outward, a squat end stone
            const wl = 1.6
            const ang = side * end * 0.45
            const pu = end * a, pv = v
            const cu = pu + end * Math.cos(ang) * wl / 2, cv = pv + side * Math.abs(Math.sin(ang)) * wl / 2
            batch.add(m.rubble, softBox(wl, parH, parT, 0.05, 1), F.at(cu, deck + parH / 2 - 0.05, cv, -ang))
            batch.add(m.granite, softBox(wl, 0.15, parT + 0.08, 0.035, 1), F.at(cu, deck + parH + 0.02, cv, -ang), tone(r))
            const eu = pu + end * Math.cos(ang) * wl, ev = pv + side * Math.abs(Math.sin(ang)) * wl
            // the end post: a dressed pier with a pyramidal cap
            batch.add(m.granite, softBox(0.46, 0.72, 0.46, 0.04, 1), F.at(eu, deck + 0.31, ev, 0.3), tone(r, 0.7, 0.9))
            batch.add(m.granite, softBox(0.54, 0.08, 0.54, 0.02, 1), F.at(eu, deck + 0.74, ev, 0.3), tone(r, 0.7, 0.9))
            const cap = cylinder(0.02, 0.3, 0.16, 4)
            batch.add(m.granite, cap, F.at(eu, deck + 0.78, ev, 0.3 + Math.PI / 4), tone(r, 0.7, 0.9))
        }
    }
    return {frame: F, springing: o.center.y + yS, crown: o.center.y + cy + R, span, width: W}
}

/** Red and white snow poles along the outer edge of the road, one every `every` metres. */
export function buildSnowPoles(batch: TintBatch, m: AlpineMaterials, road: GroundPath, o: {
    every: number, offset: number, side: (s: number) => number, skip: (s: number) => boolean, ground: (x: number, z: number) => number}) {
    const r = rng(7)
    const g0 = cylinder(0.035, 0.035, 1.9, 8)
    for (let s = 3; s < road.length - 2; s += o.every * (0.85 + 0.3 * r())) {
        if (o.skip(s)) continue
        const {p, dir} = road.at(s)
        const side = o.side(s)
        const x = p.x - dir.z * o.offset * side, z = p.z + dir.x * o.offset * side
        const y = o.ground(x, z) - 0.25
        const lean = (r() - 0.5) * 0.08
        batch.add(m.pole, g0.clone(), new Matrix4().makeRotationZ(lean).setPosition(x, y, z))
    }
}

/** Timber rail (posts and two log rails) along the road between s0 and s1, `offset` to one side. */
export function buildRail(batch: TintBatch, m: AlpineMaterials, road: GroundPath, o: {
    s0: number, s1: number, offset: number, side: number, ground: (x: number, z: number) => number}) {
    const r = rng(Math.round(o.s0 * 13))
    const posts: Vector3[] = []
    const n = Math.max(2, Math.round((o.s1 - o.s0) / 2.2))
    for (let i = 0; i <= n; i++) {
        const s = o.s0 + (o.s1 - o.s0) * i / n
        const {p, dir} = road.at(s)
        const x = p.x - dir.z * o.offset * o.side, z = p.z + dir.x * o.offset * o.side
        const y = o.ground(x, z)
        posts.push(new Vector3(x, y, z))
        batch.add(m.timberY, softBox(0.15, 1.25, 0.15, 0.02, 1), new Matrix4().makeRotationY(Math.atan2(-dir.z, dir.x) + (r() - 0.5) * 0.1).setPosition(x, y + 0.42, z), tone(r, 0.85, 1.1))
    }
    for (let i = 0; i < posts.length - 1; i++) {
        const a = posts[i], b = posts[i + 1]
        for (const h of [0.55, 0.95]) {
            const pa = a.clone().setY(a.y + h), pb = b.clone().setY(b.y + h)
            const len = pa.distanceTo(pb) + 0.25
            const g = cylinder(0.055, 0.06, len, 7)
            g.translate(0, -len / 2, 0)
            const dirv = pb.clone().sub(pa).normalize()
            const q = new Matrix4().lookAt(new Vector3(), dirv, Math.abs(dirv.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0))
            // cylinder axis is y: rotate y onto the rail direction
            const rot = new Matrix4().makeRotationX(Math.PI / 2)
            const M = q.multiply(rot).setPosition(pa.clone().add(pb).multiplyScalar(0.5))
            batch.add(m.timberSnowX, g, M, tone(r, 0.85, 1.1))
        }
    }
}

/** A yellow hiking signpost: a larch post with three arrow plates and a small summit plate. */
export function buildSignpost(batch: TintBatch, m: AlpineMaterials, at: Vector3, yaw: number) {
    const F = new Frame(at, yaw)
    batch.add(m.timberY, softBox(0.11, 2.5, 0.11, 0.015, 1), F.at(0, 1.05, 0))
    batch.add(m.iron, box(0.15, 0.04, 0.15), F.at(0, 2.32, 0))
    const plates: [number, number, number][] = [[1.95, 1, 0.1], [1.72, -1, -0.15], [1.49, 1, 0.6]]
    for (const [y, side, turn] of plates) {
        const shape = new Shape()
        const Lp = 0.62, H = 0.16
        shape.moveTo(0, -H / 2)
        shape.lineTo(Lp - 0.1, -H / 2)
        shape.lineTo(Lp, 0)
        shape.lineTo(Lp - 0.1, H / 2)
        shape.lineTo(0, H / 2)
        shape.lineTo(0, -H / 2)
        const g = extrudeSoft(shape, 0.025, 0.006, 4, 1)
        g.translate(0.06, 0, -0.0125)
        if (side < 0) g.applyMatrix4(new Matrix4().makeRotationY(Math.PI))
        batch.add(m.sign, g, F.at(0, y, 0, turn))
        // text lines and the white-red-white mark
        for (let i = 0; i < 2; i++) {
            const t = box(0.3 - i * 0.08, 0.018, 0.03)
            t.translate(side * (0.27 - i * 0.04), 0.035 - i * 0.05, 0)
            batch.add(m.signText, t, F.at(0, y, 0, turn))
        }
    }
    return F
}

/** A cairn of flat stones, about `h` high. */
export function buildCairn(batch: TintBatch, m: AlpineMaterials, at: Vector3, h = 1.3) {
    const r = rng(5)
    let y = at.y - 0.1
    let rad = 0.55
    while (y < at.y + h) {
        const t = 0.12 + 0.1 * r()
        const n = rad > 0.3 ? 5 : 1
        for (let i = 0; i < n; i++) {
            const a = i / n * 6.28 + r()
            const d = n > 1 ? rad * 0.55 : 0
            batch.add(m.graniteSnow, softBox(rad * (n > 1 ? 0.9 : 1.6) * (0.8 + 0.4 * r()), t, rad * (n > 1 ? 0.7 : 1.3), 0.04, 1),
                new Matrix4().makeRotationY(r() * 6.28).multiply(new Matrix4().makeRotationX((r() - 0.5) * 0.15)).setPosition(at.x + Math.cos(a) * d, y + t / 2, at.z + Math.sin(a) * d), tone(r, 0.75, 1.15))
        }
        y += t * 0.9
        rad *= 0.86
    }
}

/**
 * The herdsman's hut: rubble ground floor (lime render flaking), a larch log upper floor, a shallow gable roof of
 * shingles with stones on it, a chimney, red shutters, a door, a bench along the front and a woodpile on the side.
 * Local frame: x across the front (width w), z front-back (depth d), the door on +z; `ground` is the pad height.
 */
export function buildHut(batch: TintBatch, m: AlpineMaterials, o: {x: number, z: number, rot: number, w: number, d: number, ground: number}) {
    const r = rng(77)
    const F = new Frame(new Vector3(o.x, o.ground, o.z), o.rot)
    const {w, d} = o
    const h1 = 1.9, h2 = 1.5, wallT = 0.5
    // ground floor: rubble with render on the front
    const front = new Shape()
    front.moveTo(-w / 2, -1.2)
    front.lineTo(w / 2, -1.2)
    front.lineTo(w / 2, h1)
    front.lineTo(-w / 2, h1)
    front.lineTo(-w / 2, -1.2)
    const door = [-0.45, 0.45, 0, 1.75]
    const hole = new Shape().moveTo(door[0], door[2]).lineTo(door[1], door[2]).lineTo(door[1], door[3]).lineTo(door[0], door[3]).lineTo(door[0], door[2])
    front.holes.push(hole as any)
    const win = [1.0, 1.6, 0.9, 1.5]
    front.holes.push(new Shape().moveTo(win[0], win[2]).lineTo(win[1], win[2]).lineTo(win[1], win[3]).lineTo(win[0], win[3]).lineTo(win[0], win[2]) as any)
    batch.add(m.render, extrudeSoft(front, wallT, 0.04, 4, 1), F.at(0, 0, d / 2 - wallT))
    batch.add(m.rubble, softBox(w, h1 + 1.2, wallT, 0.05, 1), F.at(0, h1 / 2 - 0.6, -d / 2 + wallT / 2))
    for (const side of [-1, 1]) batch.add(m.rubble, softBox(wallT, h1 + 1.2, d - 2 * wallT, 0.05, 1), F.at(side * (w / 2 - wallT / 2), h1 / 2 - 0.6, 0))
    // door and window: larch boards, a dark interior behind the window, shutters folded open
    batch.add(m.timberY, box(0.9, 1.75, 0.06), F.at(0, 0.875, d / 2 - wallT + 0.12))
    for (let i = 0; i < 4; i++) batch.add(m.iron, box(0.5, 0.04, 0.02), F.at(-0.15, 0.3 + i * 0.4, d / 2 - wallT + 0.16))
    batch.add(m.dark, box(0.6, 0.6, 0.05), F.at(1.3, 1.2, d / 2 - wallT + 0.1))
    batch.add(m.glass, box(0.56, 0.56, 0.02), F.at(1.3, 1.2, d / 2 - 0.12))
    for (const side of [-1, 1]) batch.add(m.shutter, softBox(0.32, 0.66, 0.04, 0.01, 1), F.at(1.3 + side * 0.48, 1.2, d / 2 + 0.03, side * 0.15))
    // upper floor: horizontal larch logs, notched corners standing out
    const logR = 0.11
    const logs = Math.floor(h2 / (logR * 1.9))
    for (let i = 0; i < logs; i++) {
        const y = h1 + logR + i * logR * 1.9
        for (const side of [-1, 1]) {
            const gx = cylinder(logR, logR, w + 0.5, 8)
            gx.translate(0, -(w + 0.5) / 2, 0)
            batch.add(m.timberX, gx, F.at(0, y + (i % 2) * 0.0, side * (d / 2 - logR), 0, Math.PI / 2), tone(r, 0.85, 1.1))
            const gz = cylinder(logR, logR, d + 0.5, 8)
            gz.translate(0, -(d + 0.5) / 2, 0)
            batch.add(m.timberZ, gz, F.at(side * (w / 2 - logR), y + logR * 0.95, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)), tone(r, 0.85, 1.1))
        }
    }
    // upper window on the front
    batch.add(m.dark, box(0.55, 0.45, 0.3), F.at(-1.0, h1 + 0.75, d / 2 - 0.05))
    batch.add(m.glass, box(0.5, 0.4, 0.02), F.at(-1.0, h1 + 0.75, d / 2 + 0.08))
    for (const side of [-1, 1]) batch.add(m.shutter, softBox(0.27, 0.5, 0.04, 0.01, 1), F.at(-1.0 + side * 0.42, h1 + 0.75, d / 2 + 0.14, side * 0.2))
    // gable ends: boards up to the ridge
    const top = h1 + h2
    const pitch = 0.42, ridge = top + Math.tan(pitch) * (w / 2 + 0.6)
    for (const side of [-1, 1]) {
        const gs = new Shape()
        gs.moveTo(-w / 2, top)
        gs.lineTo(w / 2, top)
        gs.lineTo(0, top + Math.tan(pitch) * w / 2)
        gs.lineTo(-w / 2, top)
        batch.add(m.timberY, extrudeSoft(gs, 0.08, 0.01, 2, 1), F.at(0, 0, side * (d / 2 - 0.06) - 0.04))
    }
    // roof: two shingle slabs overhanging, a ridge board, stones holding the shingles down
    const half = w / 2 + 0.6
    const slope = half / Math.cos(pitch)
    for (const side of [-1, 1]) {
        const g = box(slope, 0.14, d + 1.2)
        batch.add(m.shingles, g, F.at(side * half / 2, ridge - Math.tan(pitch) * half / 2 + 0.07, 0, 0, -side * pitch))
        for (let k = 0; k < 7; k++) {
            const t = 0.25 + 0.55 * r()
            const u = side * half * t, y = ridge - Math.tan(pitch) * half * t + 0.2
            batch.add(m.graniteSnow, softBox(0.3 + 0.2 * r(), 0.17, 0.3 + 0.2 * r(), 0.06, 1), F.at(u, y, (r() - 0.5) * (d + 0.6), r() * 3, -side * pitch), tone(r))
        }
    }
    batch.add(m.timberZ, softBox(0.2, 0.12, d + 1.3, 0.02, 1), F.at(0, ridge + 0.1, 0))
    // chimney
    batch.add(m.rubble, softBox(0.6, 1.3, 0.6, 0.04, 1), F.at(-0.9, ridge - 0.1, -d / 4))
    batch.add(m.graniteSnow, softBox(0.8, 0.1, 0.8, 0.03, 1), F.at(-0.9, ridge + 0.6, -d / 4))
    // bench along the front, a chopping block and a woodpile under the eaves on the side
    batch.add(m.timberX, softBox(1.8, 0.07, 0.36, 0.015, 1), F.at(-1.0, 0.45, d / 2 + 0.3))
    for (const s of [-1, 1]) batch.add(m.timberY, box(0.08, 0.42, 0.3), F.at(-1.0 + s * 0.75, 0.21, d / 2 + 0.3))
    const stump = cylinder(0.22, 0.25, 0.5, 10)
    batch.add(m.timberY, stump, F.at(1.9, 0, d / 2 + 0.9))
    const pile = (u0: number, v0: number) => {
        for (let row = 0; row < 5; row++) for (let i = 0; i < 9; i++) {
            const lg = cylinder(0.07 + 0.03 * r(), 0.08, 0.5, 6)
            lg.translate(0, -0.25, 0)
            batch.add(m.timberZ, lg, F.at(u0, 0.08 + row * 0.15, v0 + i * 0.17 + (row % 2) * 0.08).multiply(new Matrix4().makeRotationZ(Math.PI / 2)), tone(r, 0.8, 1.2))
        }
    }
    pile(w / 2 + 0.55, -d / 2 + 0.6)
    return F
}

/**
 * An avalanche cone left in the gorge in summer: a lumpy mound of old snow from wall to wall over a stretch of the
 * floor, the creek running under it. `ground` is the floor, `path` the gorge, `s0`..`s1` its stretch.
 */
export function buildSnowCone(batch: TintBatch, m: AlpineMaterials, path: GroundPath, o: {s0: number, s1: number, width: number, height: number, ground: (x: number, z: number) => number}) {
    const nu = 90, nv = 40
    const pos: number[] = [], idx: number[] = []
    const r = rng(3)
    const bumps = Array.from({length: 14}, () => [r(), r() * 2 - 1, 0.2 + 0.5 * r()])
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
        const u = i / nu, v = j / nv * 2 - 1
        const s = o.s0 + (o.s1 - o.s0) * u
        const {p, dir} = path.at(s)
        const across = v * o.width / 2
        const x = p.x - dir.z * across, z = p.z + dir.x * across
        let h = o.height * Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.55) * Math.pow(Math.max(0, 1 - v * v), 0.35) * (0.75 + 0.25 * (1 - u))
        for (const [bu, bv, bh] of bumps) h += 0.22 * bh * o.height * Math.exp(-((u - bu) ** 2 * 90 + (v - bv) ** 2 * 10))
        // the mound rides up the walls a little at its sides
        const floor = path.at(s).p.y
        pos.push(x, Math.min(o.ground(x, z), floor + 0.4) - 0.1 + h + Math.abs(v) ** 3 * 0.25, z)
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1
        idx.push(a, b, c, b, d, c)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    // face up
    const ny = (g.attributes.normal as BufferAttribute).getY((nu / 2) * (nv + 1) + nv / 2)
    if (ny < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t } g.setIndex(idx); g.computeVertexNormals() }
    batch.add(m.firn, g)
}

export function dispose(g: BufferGeometry) { g.dispose() }
