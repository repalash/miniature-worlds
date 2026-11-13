import {Vector3} from 'threepipe'
import {Noise2, rng, smoothstep} from '../../kit/noise'
import type {Placement, ScatterRule} from '../../kit/scatter'
import {scatterOnTerrain} from '../../kit/scatter'
import type {Terrain} from '../../kit/terrain'
import {GORGE, HUT, ROAD, ROAD_HALF, snowAt, TARN} from './terrain'

/**
 * Where things grow and lie on the alpine pass: spruce forest stepping down the flanks below a ragged tree line
 * (in clumps, thinning to stunted trees near it), golden grass and gentians on the meadows, boulders on the meadow
 * and the scree, rock crags along the gorge. Each rule is a density in (x, z, height, slope), so a game can reuse
 * it on its own terrain.
 */

const n = new Noise2(23)

/** Room kept clear: the road with its verges, the gorge, the tarn, the hut and the bridge ends. */
export function clear(x: number, z: number, margin = 0) {
    const r = ROAD.nearest(x, z, 6)
    if (r.d < ROAD_HALF + 1.2 + margin) return true
    const g = GORGE.nearest(x, z, 6)
    if (g.d < 2.6 + margin) return true
    if (Math.hypot((x - TARN.x) * 0.85, z - TARN.z) < TARN.r + 0.8 + margin) return true
    if (Math.hypot(x - HUT.x, z - HUT.z) < 5 + margin) return true
    return false
}

/** Tree line (m): ragged, lower on the shaded back slopes. */
export const treeLine = (x: number, z: number) => 10.6 + 1.4 * n.fbm(x * 0.08, z * 0.08 + 5, 3) + 0.04 * z

/** Spruce density: clumps below the tree line. */
export function forest(x: number, z: number, h: number, slope: number) {
    if (clear(x, z) || slope > 0.5) return 0
    const tl = treeLine(x, z)
    const below = smoothstep(tl, tl - 2.5, h)
    const clumps = smoothstep(-0.15, 0.35, n.fbm(x * 0.07 + 2, z * 0.07, 3))
    // the open meadow in the front right stays mostly open; the flanks are forested
    const meadow = smoothstep(14, 4, Math.hypot(x - 12, z - 15))
    return below * clumps * (1 - 0.85 * meadow)
}

/** Stunted spruces and krummholz round the tree line. */
export function treeLineScrub(x: number, z: number, h: number, slope: number) {
    if (clear(x, z) || slope > 0.55) return 0
    const tl = treeLine(x, z)
    return smoothstep(tl - 2.5, tl - 0.5, h) * smoothstep(tl + 2.2, tl + 0.5, h) * 0.8
}

export const spruceRule = (count = 120): ScatterRule => ({count, seed: 11, density: forest, spacing: 2.3, scale: [0.55, 1.15], sink: 0.02, tries: 60})
export const scrubRule = (count = 40): ScatterRule => ({count, seed: 12, density: treeLineScrub, spacing: 1.8, scale: [0.18, 0.4], sink: 0.02, tries: 60})

/** Grass tufts: everywhere on the meadows below the snow, thinner on scree and cliffs, none on the road bed. */
export function grass(terrain: Terrain) {
    return (x: number, z: number, h: number, slope: number) => {
        const r = ROAD.nearest(x, z, 4)
        if (r.d < ROAD_HALF - 0.2 && r.d > 0.35) return 0
        const g = GORGE.nearest(x, z, 3)
        if (g.d < 1.6) return 0
        if (Math.hypot((x - TARN.x) * 0.85, z - TARN.z) < TARN.r - 0.3) return 0
        const snow = snowAt(x, z, h, slope, terrain.normalAt(x, z).z)
        return (1 - smoothstep(0.1, 0.4, snow)) * (1 - smoothstep(0.35, 0.6, slope)) * (1 - 0.6 * terrain.mask('talus', x, z)) * (0.5 + 0.5 * smoothstep(-0.3, 0.3, n.fbm(x * 0.15, z * 0.15, 3)))
    }
}

/** Alpine flowers: gentians, globe flowers and edelweiss in patches on the open meadows. */
export function flowers(terrain: Terrain) {
    const g = grass(terrain)
    return (x: number, z: number, h: number, slope: number) => g(x, z, h, slope) * smoothstep(0.1, 0.45, n.fbm(x * 0.25 + 40, z * 0.25, 2)) * (h > 4 ? 1 : 0.5)
}

/** Boulders: fallen from the peak and the ridge onto the meadow and the scree. */
export function boulders(terrain: Terrain) {
    return (x: number, z: number, h: number, slope: number) => {
        if (clear(x, z, 0.3)) return 0
        return (0.15 + 0.85 * smoothstep(7, 12, h)) * smoothstep(17, 14, h) * (0.3 + terrain.mask('talus', x, z)) * smoothstep(0.42, 0.22, slope)
    }
}

/**
 * Crags along the gorge walls: rock-face scans set into the walls, facing across the gorge, in two tiers (at the
 * floor, and under the rim), avoiding the bridge.
 */
export function gorgeCrags(height: (x: number, z: number) => number, bridgeS: number) {
    const r = rng(9)
    const out: {position: Vector3, rotationY: number, scale: number, kind: number}[] = []
    for (const side of [-1, 1]) {
        for (let s = 3; s < GORGE.length - 1; s += 2.2 + 1.6 * r()) {
            if (s > bridgeS - 2.6 && s < bridgeS + 9) continue
            const {p, dir} = GORGE.at(s)
            const off = 1.7 + 0.3 * r()
            const x = p.x - dir.z * off * side, z = p.z + dir.x * off * side
            // face across the gorge (the scans face +z; a yaw t turns +z to (sin t, cos t))
            const face = Math.atan2(dir.z * side, -dir.x * side)
            out.push({position: new Vector3(x, Math.min(height(x, z), p.y + 3.5) - 1.2 - r() * 0.6, z), rotationY: face + (r() - 0.5) * 0.4, scale: 0.6 + 0.4 * r(), kind: r() < 0.6 ? 0 : 1})
        }
    }
    return out
}

export {scatterOnTerrain}
export type {Placement}
