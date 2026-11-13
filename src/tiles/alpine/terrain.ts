import {Noise2, smoothstep} from '../../kit/noise'
import {GroundPath} from '../../kit/path'
import type {TerrainLayer, TerrainSample} from '../../kit/terrain'
import {blendLayer} from '../../kit/terrain'
import type {StrataSpec} from '../../kit/beds'

/**
 * The alpine pass as a landform, reusable as a game biome: a granite peak with a snow cap in one corner, a ridge
 * along the back with a saddle where the road leaves, a cirque with a meltwater tarn under the snowfield, a gorge
 * that drains the tarn and cuts through the front face, golden grass on the lower slopes. A gravel road climbs from
 * the low meadow, crosses the gorge on a stone bridge and climbs two hairpins to the saddle; the ground is cut and
 * filled along it. Everything is a pure function of (x, z) in metres (the tile spans -SIZE/2..SIZE/2).
 */

export const SIZE = 56
const n = new Noise2(17)

/** The road: control points (x, road height, z). The bridge spans the gorge between the 3rd and 4th points. */
export const ROAD = new GroundPath([
    [-60, 1.4, 28],
    [-42, 2.3, 23.5],
    [-30, 3.0, 19.5],
    [-20, 3.6, 15.5],
    [-12, 4.3, 10.4],
    [-6.6, 4.85, 6.6],
    [0.6, 5.15, 4.2],
    [9, 5.75, 4.4],
    [16.5, 6.3, 3.2],
    [20.5, 6.55, -0.6],
    [17.5, 6.9, -4.4],
    [9, 7.85, -7.4],
    [2.5, 8.55, -11.2],
    [2.6, 8.9, -15.6],
    [8.5, 9.75, -19.8],
    [12.5, 10.4, -24],
    [14, 10.8, -30],
    [15.5, 11.4, -45],
    [13, 12.5, -70],
], 0.2)
export const ROAD_HALF = 1.9

/** The gorge: centreline control points (x, floor height, z), from the tarn outlet to the front face. */
export const GORGE = new GroundPath([
    [-8.2, 9.1, -3.9],
    [-6.7, 7.7, -1.4],
    [-5.4, 3.4, 1.2],
    [-3.2, 1.0, 4.6],
    [-1.4, 0.2, 9.5],
    [1.8, -0.8, 15.5],
    [3.4, -1.7, 21.5],
    [4.2, -2.6, 29],
    [5.5, -3.6, 42],
    [4, -5, 60],
    [7, -6.5, 85],
], 0.2)

let bridgeS: number | undefined
/** Distance along the road of the bridge's centre. */
export const BRIDGE_S = () => bridgeS ??= bridgeSite().s

/** The bridge: where the road crosses the gorge (found at load), deck height. */
export function bridgeSite() {
    let best = {s: 0, d: Infinity}
    for (let s = 0; s < ROAD.length; s += 0.1) {
        const {p} = ROAD.at(s)
        const g = GORGE.nearest(p.x, p.z, 6)
        if (g.d < best.d) best = {s, d: g.d}
    }
    const {p, dir} = ROAD.at(best.s)
    return {s: best.s, center: p, dir}
}

export const TARN = {x: -14.2, z: -2.8, r: 5.8, level: 9.25}
export const PEAK = {x: -19, z: -19}
/** The herdsman's hut on the cirque bench: centre, facing (radians about y, its door side toward +local z), size. */
export const HUT = {x: -21.6, z: 4.2, rot: 1.0, w: 4.4, d: 5.4}

/** The natural ground before the road and the gorge. */
export function baseHeight(x: number, z: number) {
    const back = smoothstep(14, -28, z)
    let h = 2.0 + 4.2 * back + 0.07 * Math.max(0, -x) * (0.5 + back)
    // the peak: a horn, faces meeting in sharp ridges (the max of five planes), gullied, on a broad apron
    const dp = Math.hypot(x - PEAK.x, z - PEAK.z)
    const ridges = n.ridged(x * 0.09 + 3, z * 0.09, 4)
    h += 5 * Math.exp(-(dp * dp) / (2 * 11 * 11)) * (0.8 + 0.4 * ridges)
    {
        // five faces of different steepness, the planes warped so the ridges wander, cliff bands stepping the faces
        const wx = x + 2.2 * n.fbm(x * 0.07 + 31, z * 0.07, 3), wz = z + 2.2 * n.fbm(x * 0.07, z * 0.07 + 17, 3)
        let f = 0
        for (let k = 0; k < 5; k++) {
            const a = 0.3 + k * 1.2566 + 0.35 * Math.sin(k * 2.1 + 1)
            const steep = 1.3 + 0.5 * (0.5 + 0.5 * Math.sin(k * 3.7))
            f = Math.max(f, ((wx - PEAK.x) * Math.cos(a) + (wz - PEAK.z) * Math.sin(a)) * steep)
        }
        const gully = 0.9 * n.ridged(Math.atan2(z - PEAK.z, x - PEAK.x) * 3, dp * 0.15, 3)
        let horn = 25 - f + 1.2 * n.fbm(x * 0.15, z * 0.15 + 7, 3) - 1.6 * gully + 0.8 * n.ridged(x * 0.35, z * 0.35 + 2, 3)
        // cliff bands: the faces step every 2.5 m
        const band = horn / 2.5
        horn += ((Math.floor(band) + smoothstep(0.2, 0.8, band - Math.floor(band))) * 2.5 - horn) * 0.55
        h = Math.max(h, horn - 4)
    }
    // the back ridge, with a saddle where the road leaves, and a knob in the back right corner
    h += 4.5 * smoothstep(-14, -28, z) * (0.7 + 0.5 * n.ridged(x * 0.12, z * 0.12 + 9, 3))
    h -= 4.2 * Math.exp(-((x - 13) ** 2) / (2 * 4.5 * 4.5)) * smoothstep(-16, -28, z)
    h += 5 * Math.exp(-((x - 27) ** 2 + (z + 26) ** 2) / (2 * 6 * 6))
    // the right flank, a spur running down toward the front
    h += 2.2 * Math.exp(-((x - 24) ** 2) / (2 * 5 * 5)) * smoothstep(20, -10, z)
    // rolling meadow, rock knobs higher up
    h += 0.7 * n.fbm(x * 0.06, z * 0.06, 4) + 0.18 * n.fbm(x * 0.25 + 5, z * 0.25, 3)
    h += 1.4 * Math.max(0, h - 8) / 10 * n.ridged(x * 0.2 + 11, z * 0.2, 3)
    // the cirque bench round the tarn, and its bowl
    const dt = Math.hypot((x - TARN.x) * 0.85, z - TARN.z) + 1.2 * n.fbm(x * 0.15, z * 0.15 + 4, 2)
    const bench = 1 - smoothstep(TARN.r + 2, TARN.r + 8, dt)
    // the shore just above the water, the bowl 2 m deep in the middle, the bench rising gently behind the shore
    const target = dt < TARN.r ? TARN.level + 0.12 - 2.1 * (1 - (dt / TARN.r) ** 2) : TARN.level + 0.12 + 0.06 * (dt - TARN.r) ** 2
    h = h + (target - h) * bench
    return h
}

/** Road weight (1 on the road bed) and road height at a point. */
export function roadAt(x: number, z: number) {
    const r = ROAD.nearest(x, z, 10)
    return {w: 1 - smoothstep(ROAD_HALF + 0.3, ROAD_HALF + 0.9, r.d), d: r.d, y: r.y, s: r.s}
}

/** Final height: the ground cut and filled along the road, then the gorge cut through everything. */
export function height(x: number, z: number) {
    let h = baseHeight(x, z)
    // a level pad for the hut
    {
        const c = Math.cos(HUT.rot), s = Math.sin(HUT.rot)
        const lx = (x - HUT.x) * c - (z - HUT.z) * s, lz = (x - HUT.x) * s + (z - HUT.z) * c
        const d = Math.max(Math.abs(lx) - HUT.w / 2 - 0.8, Math.abs(lz) - HUT.d / 2 - 1.4, 0)
        const pad = baseHeight(HUT.x, HUT.z)
        h += (pad - h) * (1 - smoothstep(0, 2.5, d))
    }
    const r = ROAD.nearest(x, z, 10)
    if (r.d < 10) {
        // cut and fill: the bed is flat across, the banks run out at about 35 degrees
        const bank = ROAD_HALF + 0.5 + Math.abs(h - r.y) * 1.3
        const w = 1 - smoothstep(ROAD_HALF + 0.4, bank, r.d)
        // a slight camber and two ruts
        const rut = -0.05 * (Math.exp(-((r.d - 0.75) ** 2) / 0.02))
        h = h + (r.y + rut - 0.02 * r.d - h) * w
    }
    const g = GORGE.nearest(x, z, 12)
    if (g.d < 12) {
        const wob = 0.35 * n.fbm(x * 0.4, z * 0.4 + 2, 3) + 0.25 * n.ridged(x * 0.9, z * 0.9, 2)
        const dd = Math.max(0, g.d + wob - 1.1)
        // steep walls (about 75 degrees), the floor stepped in small falls
        const floor = g.y + 0.35 * Math.sin(g.s * 0.9) * smoothstep(2, 6, g.s)
        const cut = floor + Math.pow(dd, 1.15) * 3.8
        h = Math.min(h, cut)
        // the creek bed
        h -= 0.25 * (1 - smoothstep(0.2, 0.9, g.d))
        // the bridge's abutments: the road bed stays whole beyond the arch's span
        if (r.d < ROAD_HALF + 1.2) {
            const bs = Math.abs(r.s - BRIDGE_S())
            if (bs > 3.2 && bs < 8) h = Math.max(h, r.y - 0.03 - 0.6 * smoothstep(ROAD_HALF, ROAD_HALF + 1.2, r.d))
        }
    }
    return h
}

/** Snow cover 0..1 from height, slope and exposure (the snow lies longer in the cirque and on north faces). */
export function snowAt(x: number, z: number, h: number, slope: number, nz: number) {
    const line = 12.2 + 1.8 * n.fbm(x * 0.07 + 20, z * 0.07, 3) - 1.6 * smoothstep(0, -0.6, nz)
    let s = smoothstep(line - 1.2, line + 0.8, h)
    // patches in the cirque above the tarn and on the north side of the back ridge
    const dt = Math.hypot(x - TARN.x + 1, z - TARN.z + 6)
    s = Math.max(s, (1 - smoothstep(4, 8, dt)) * smoothstep(-0.1, 0.4, n.fbm(x * 0.2, z * 0.2 + 3, 3)) * smoothstep(9.2, 10, h))
    // avalanche snow in the gorge under the bridge
    const g = GORGE.nearest(x, z, 4)
    if (g.d < 3) s = Math.max(s, (1 - smoothstep(0.5, 2.6, g.d)) * (1 - smoothstep(1.5, 4, Math.abs(g.s - 10.5))) * smoothstep(-0.3, 0.2, n.fbm(x * 0.5, z * 0.5, 2)))
    // wind strips the steep faces; on the horn the snow lies in the gullies and on the ledges, in streaks
    const streaks = smoothstep(0.45, 0.7, n.ridged(x * 0.22 + 9, z * 0.22 - h * 0.1, 3)) * smoothstep(13, 16, h) * (1 - smoothstep(0.5, 0.7, slope))
    return Math.max(s * (1 - smoothstep(0.24, 0.4, slope)), streaks * 0.9)
}

/** The four ground layers: golden alpine grass, gravel (road and scree), snow, dark gneiss (triplanar on cliffs). */
export const LAYERS: TerrainLayer[] = [
    {id: 'aerial_grass_rock', tile: 5, tint: [0.95, 0.9, 0.62]},
    {id: 'rocky_trail', tile: 3, tint: [0.78, 0.76, 0.74]},
    {id: 'snow_02', tile: 4, tint: [1.0, 1.0, 1.0], roughness: 0.8},
    {id: 'dark_rock', tile: 6, tint: [2.3, 2.3, 2.45], normal: 1.4},
]

/** Splat rule: which layer where, and the tint (golden ridges, green hollows, dark wet gorge). */
export function paint(s: TerrainSample, w: number[], tint: number[]) {
    const {x, z, h, slope} = s
    const r = roadAt(x, z)
    const g = GORGE.nearest(x, z, 4)
    const cliff = smoothstep(0.24, 0.45, slope)
    w[0] = 1
    // scree on the talus and the high slopes, the road bed
    const high = smoothstep(9, 14, h)
    blendLayer(w, 1, Math.max(smoothstep(0.1, 0.5, s.talus) * 0.9, high * 0.5 * smoothstep(-0.2, 0.4, n.fbm(x * 0.2, z * 0.2, 3)), smoothstep(0.3, 0.7, s.eroded) * 0.6))
    // the road: gravel, with grass in the middle strip and at the verges
    const strip = 1 - smoothstep(0.15, 0.35, r.d)
    blendLayer(w, 1, r.w * (1 - 0.75 * strip))
    blendLayer(w, 3, cliff * (1 - r.w))
    // the gorge floor: wet cobbles
    if (g.d < 1.4) blendLayer(w, 1, 1 - smoothstep(0.6, 1.4, g.d))
    blendLayer(w, 2, snowAt(x, z, h, slope, s.n.z) * (1 - 0.6 * cliff))
    // grass colour: golden on the dry ridges and the sunny slopes, greener in hollows and by the water
    const dry = smoothstep(-0.3, 0.5, n.fbm(x * 0.05 + 3, z * 0.05, 3) + 0.6 * (s.n.x * 0.5 - s.n.z * 0.2))
    const wet = Math.max(1 - smoothstep(TARN.r, TARN.r + 3, Math.hypot(x - TARN.x, z - TARN.z)), 1 - smoothstep(1, 3.5, g.d), smoothstep(0.1, 0.6, s.flow) * 0.6)
    const k = 1 - 0.25 * s.flow
    tint[0] = (0.95 + 0.25 * dry - 0.3 * wet) * k
    tint[1] = (0.95 + 0.08 * dry - 0.05 * wet) * k
    tint[2] = (0.85 - 0.2 * dry - 0.1 * wet) * k
    // the grass colour is for the grass: rock, scree and snow keep their own
    const neutral = Math.min(1, w[1] + w[2] + w[3])
    for (let i = 0; i < 3; i++) tint[i] += (k * (i === 2 ? 1.02 : 1) - tint[i]) * neutral
    // ruts darker, wet gorge floor darker
    if (r.w > 0.5) {
        const rut = Math.exp(-((r.d - 0.75) ** 2) / 0.04)
        tint[0] *= 1 - 0.25 * rut; tint[1] *= 1 - 0.25 * rut; tint[2] *= 1 - 0.22 * rut
    }
    if (g.d < 2) { const d = 1 - smoothstep(0.5, 2, g.d); tint[0] *= 1 - 0.35 * d; tint[1] *= 1 - 0.32 * d; tint[2] *= 1 - 0.28 * d }
}

/** Erosion weight: none on the road, the gorge (kept crisp) and the tarn bench. */
export function erosionWeight(x: number, z: number) {
    const r = ROAD.nearest(x, z, 6)
    const g = GORGE.nearest(x, z, 6)
    const t = Math.hypot(x - TARN.x, z - TARN.z)
    const edge = Math.min(1, (SIZE / 2 - Math.max(Math.abs(x), Math.abs(z))) / 4)
    const hut = Math.hypot(x - HUT.x, z - HUT.z)
    return Math.max(0, edge) * smoothstep(ROAD_HALF + 1, ROAD_HALF + 4, r.d) * smoothstep(3, 6, g.d) * smoothstep(TARN.r + 1, TARN.r + 5, t) * smoothstep(5, 9, hut)
}

/**
 * The cut faces: turf, dark humus and grey glacial till over folded beds of the Alps' basement: banded gneiss,
 * a soft schist that weathers back, a pale marble bed that stands out, granite at the base.
 */
export const STRATA: StrataSpec = {
    soil: [
        {kind: 'turf', thickness: 0.22, color: [0.1, 0.11, 0.035], color2: [0.15, 0.13, 0.05], relief: 0.14, roughness: 0.95},
        {kind: 'soil', thickness: 0.55, color: [0.035, 0.025, 0.018], color2: [0.055, 0.04, 0.026], relief: -0.22},
        {kind: 'till', thickness: 1.6, color: [0.11, 0.1, 0.085], color2: [0.14, 0.125, 0.1], relief: 0.08, roughness: 0.92},
    ],
    top: 12,
    beds: [
        {kind: 'bedded', thickness: 2.2, color: [0.09, 0.09, 0.095], color2: [0.12, 0.115, 0.11], relief: 0.4, scale: 1.2},
        {kind: 'bedded', thickness: 1.1, color: [0.12, 0.07, 0.04], color2: [0.15, 0.09, 0.05], relief: -0.45, scale: 2},
        {kind: 'massive', thickness: 1.3, color: [0.42, 0.41, 0.39], color2: [0.5, 0.49, 0.46], relief: 0.6, roughness: 0.75},
        {kind: 'bedded', thickness: 2.6, color: [0.1, 0.1, 0.1], color2: [0.075, 0.075, 0.08], relief: 0.2, scale: 1.4},
        {kind: 'bedded', thickness: 0.9, color: [0.05, 0.065, 0.05], color2: [0.07, 0.085, 0.065], relief: -0.4, scale: 2.5},
        {kind: 'massive', thickness: 2.6, color: [0.17, 0.165, 0.16], color2: [0.21, 0.2, 0.19], relief: 0.5, roughness: 0.85},
        {kind: 'bedded', thickness: 1.0, color: [0.13, 0.08, 0.045], color2: [0.16, 0.1, 0.055], relief: -0.3, scale: 1.8},
        {kind: 'bedded', thickness: 1.8, color: [0.085, 0.085, 0.09], color2: [0.11, 0.105, 0.1], relief: 0.15, scale: 1.3},
        {kind: 'massive', thickness: 30, color: [0.15, 0.145, 0.14], color2: [0.19, 0.185, 0.175], relief: 0.35, roughness: 0.85},
    ],
    dip: [0.12, -0.06],
    fold: [1.6, 34],
    wobble: 0.4,
    seed: 5,
}
