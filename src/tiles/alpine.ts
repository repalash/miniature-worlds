import {Color, IObject3D, PhysicalMaterial, Vector3} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {SSGIPlugin} from '@threepipe/webgi-plugins'
import type {Tile} from '../types'
import {cameraRange, setCamera} from '../kit/helpers'
import {buildTerrain} from '../kit/terrain'
import {rng, smoothstep} from '../kit/noise'
import {applyTime, backdrop, stageWorld, TimePreset} from '../kit/stage'
import {forEachMesh, instance, loadTemplate, pickPart, Placement, scatterOnTerrain, tintMaterial} from '../kit/scatter'
import {worldAsset} from '../kit/assets'
import {buildCutFaces} from '../kit/beds'
import {cheapTerrain} from '../kit/terrainPatch'
import {buildConifers} from '../kit/conifer'
import {buildTufts} from '../kit/tufts'
import {buildCreek, buildPond} from '../kit/freshwater'
import {buildVista} from '../kit/vista'
import {TintBatch} from '../kit/batch'
import {baseHeight, bridgeSite, erosionWeight, GORGE, height, HUT, LAYERS, paint, PEAK, ROAD, ROAD_HALF, SIZE, STRATA, TARN} from './alpine/terrain'
import {alpineMaterials, snowCapExtension} from './alpine/materials'
import {buildBridge, buildCairn, buildHut, buildRail, buildSignpost, buildSnowCone, buildSnowPoles} from './alpine/props'
import {boulders, flowers, gorgeCrags, grass, scrubRule, spruceRule} from './alpine/scatter'
import {Noise2} from '../kit/noise'

/**
 * Alpine Pass, a diorama tile (after Prime Peaks and Hill Climb Racing 2's mountain stages): a gravel road climbs
 * from a golden meadow, crosses a gorge on a granite arch bridge and climbs two hairpins to a saddle under a
 * snow-capped peak; a meltwater tarn lies in the cirque under the snowfield, its creek falls into the gorge and cuts
 * through the front face; spruce forest steps down the flanks below a ragged tree line. The cut faces show turf,
 * humus and glacial till over folded beds of gneiss, schist and marble.
 *
 * The GI staging: crisp late-morning sun from the front left, a low sky fill. The snowfield, the snow cone in the
 * gorge and the snow on the bridge's copings are the brightest surfaces in the tile (albedo about 0.85), and they
 * light what faces them out of the sun: the shaded sides of the boulders on the snowfield, the gorge wall and the
 * arch's underside over the snow cone go blue-white with GI and stay dark grey without it. The tarn mirrors the
 * peak (SSR).
 */
export const alpine: Tile = {
    label: 'Tile: Alpine Pass',
    setup: async({viewer, rig}) => {
        const t0 = performance.now()
        const farTrees: any[] = []
        let timeFill = 0.14, timeBg = 0.8
        const m = alpineMaterials()
        const terrain = await buildTerrain(viewer, {
            size: SIZE,
            res: 360,
            height,
            base: 0,
            erosion: {hydraulic: {dropletsPerCell: 1.2, seed: 3}, thermal: {angle: 42, iterations: 30}, weight: erosionWeight},
            layers: LAYERS,
            paint,
        })
        terrain.material.registerMaterialExtensions([SNOW_SPARKLE])
        cheapTerrain(terrain.material)
        const faces = buildCutFaces(viewer, {size: SIZE, height: terrain.height, bottom: terrain.minY - 3.5, spec: STRATA, name: 'alpine'})

        // water: the tarn and the creek that falls from it into the gorge
        const tarn = buildPond(viewer, {height: terrain.height, level: TARN.level, area: [TARN.x - 8, TARN.z - 8, TARN.x + 8, TARN.z + 8],
            seed: [TARN.x, TARN.z], within: (x, z) => Math.hypot((x - TARN.x) * 0.85, z - TARN.z) < TARN.r + 0.4, shallow: [0.035, 0.07, 0.06], deep: [0.004, 0.014, 0.02], attenuation: new Color(0.3, 0.6, 0.62), attenuationDistance: 2})
        const bed = (s: number) => {
            const {p} = GORGE.at(s)
            return Math.abs(p.x) < SIZE / 2 && Math.abs(p.z) < SIZE / 2 ? terrain.height(p.x, p.z) : height(p.x, p.z)
        }
        // the gorge leaves the tile through the front face: the creek in the tile, and its run on outside (sky views)
        let faceS = 0
        while (faceS < GORGE.length && GORGE.at(faceS).p.z < SIZE / 2) faceS += 0.1
        const creekOpts = {
            surface: (s: number) => Math.max(bed(s), bed(s + 0.6) - 0.05) + 0.1,
            halfWidth: (s: number) => (s < 2 ? 0.45 : 0.7) + 0.15 * Math.sin(s * 0.7),
            white: (s: number) => smoothstep(0.15, 0.6, (bed(s - 0.4) - bed(s + 0.4)) / 0.8),
        }
        const creek = buildCreek(viewer, GORGE, {...creekOpts, range: [0, faceS]})
        const creekOut = buildCreek(viewer, GORGE, {...creekOpts, range: [faceS, GORGE.length]})

        // the bridge, the road furniture, the hut
        const site = bridgeSite()
        const batch = new TintBatch()
        const bridge = buildBridge(batch, m, {center: site.center.clone().setY(site.center.y + 0.06), dir: site.dir, span: 5.6, rise: 2.1, width: 4.4, length: 10.5})
        const outer = (s: number) => {
            // the outside of each bend: the side away from the hairpin's centre
            const a = ROAD.at(s), b = ROAD.at(s + 2)
            const turn = a.dir.x * b.dir.z - a.dir.z * b.dir.x
            return turn > 0 ? -1 : 1
        }
        // where the road leaves the tile at the back (the saddle)
        let exitS = site.s
        while (exitS < ROAD.length && ROAD.at(exitS).p.z > -SIZE / 2 + 0.5) exitS += 0.2
        const inTile = (s: number) => {
            const p = ROAD.at(s).p
            return Math.abs(p.x) < SIZE / 2 - 1 && Math.abs(p.z) < SIZE / 2 - 1
        }
        buildSnowPoles(batch, m, ROAD, {every: 7, offset: ROAD_HALF + 0.35, side: outer, skip: s => Math.abs(s - site.s) < 7 || !inTile(s), ground: terrain.height})
        for (const [s0, s1, side] of [[site.s + 19.6, site.s + 31.6, 1], [site.s + 46.6, site.s + 55.6, -1], [site.s + 5.5, site.s + 12, -1]] as const) {
            buildRail(batch, m, ROAD, {s0, s1, offset: ROAD_HALF + 0.25, side, ground: terrain.height})
        }
        const signAt = ROAD.at(site.s + 7.5)
        const signPos = signAt.p.clone().add(new Vector3(signAt.dir.z, 0, -signAt.dir.x).multiplyScalar(ROAD_HALF + 0.7))
        signPos.y = terrain.height(signPos.x, signPos.z)
        buildSignpost(batch, m, signPos, Math.atan2(-signAt.dir.z, signAt.dir.x) + 0.4)
        const cairnAt = ROAD.at(exitS - 4).p.clone().add(new Vector3(-2.6, 0, 0.5))
        cairnAt.y = terrain.height(cairnAt.x, cairnAt.z)
        buildCairn(batch, m, cairnAt, 1.4)
        buildHut(batch, m, {...HUT, ground: terrain.height(HUT.x, HUT.z)})
        const bridgeS = GORGE.nearest(site.center.x, site.center.z).s
        buildSnowCone(batch, m, GORGE, {s0: bridgeS + 0.6, s1: bridgeS + 5.8, width: 2.8, height: 1.0, ground: terrain.height})
        batch.build(viewer, 'Alpine props')

        // the eye-level shots (camera, target, fov); no tree grows in front of a camera
        const c = site.center, d = site.dir
        const onRoad = (s: number, up: number, side = 0): [number, number, number] => {
            const a = ROAD.at(s)
            const x = a.p.x - a.dir.z * side, z = a.p.z + a.dir.x * side
            return [x, terrain.height(x, z) + up, z]
        }
        const inGorge = (s: number, up: number, side = 0): [number, number, number] => {
            const a = GORGE.at(s)
            const x = a.p.x - a.dir.z * side, z = a.p.z + a.dir.x * side
            return [x, terrain.height(x, z) + up, z]
        }
        type Shot = {cam: [number, number, number], target: [number, number, number], fov: number}
        const shots: Record<string, Shot> = {
            'Bridge': {cam: onRoad(site.s - 10.5, 1.6, -0.7), target: [c.x + d.x * 7, c.y + 2.2, c.z + d.z * 7], fov: 50},
            'Under the arch': {cam: inGorge(bridgeS + 7.2, 1.25, 0.1), target: [c.x, bridge.springing + 1.6, c.z], fov: 62},
            'Tarn': {cam: [TARN.x + 1.8, TARN.level + 1.15, TARN.z + TARN.r + 0.2], target: [PEAK.x + 1, 13, PEAK.z + 1], fov: 56},
            'Hut': (() => {
                // in front of the door (the hut's local +z), a little to the side
                const fx = Math.sin(HUT.rot), fz = Math.cos(HUT.rot)
                const x = HUT.x + fx * 7.5 - fz * 2.5, z = HUT.z + fz * 7.5 + fx * 2.5
                const g = terrain.height(HUT.x, HUT.z)
                return {cam: [x, Math.max(terrain.height(x, z), g - 0.6) + 1.6, z], target: [HUT.x + fx * 1.5, g + 1.9, HUT.z + fz * 1.5], fov: 50} as Shot
            })(),
            'Switchbacks': {cam: [25.5, terrain.height(25.5, -17) + 7.5, -17], target: [3, 4.2, 7], fov: 50},
        }
        const viewClear = (x: number, z: number) => {
            for (const k in shots) {
                const {cam, target} = shots[k]
                const dx = x - cam[0], dz = z - cam[2]
                if (dx * dx + dz * dz < 7 * 7) return false
                // a corridor 3 m wide along the first 14 m of the view
                const vx = target[0] - cam[0], vz = target[2] - cam[2], vl = Math.hypot(vx, vz)
                const along = (dx * vx + dz * vz) / vl, across = Math.abs(dx * vz - dz * vx) / vl
                if (along > 0 && along < 14 && across < 1.5 + along * 0.12) return false
            }
            return true
        }

        // spruce forest and stunted trees at the tree line
        const spruce = scatterOnTerrain(terrain, spruceRule(85)).filter(p => viewClear(p.position.x, p.position.z))
        const scrub = scatterOnTerrain(terrain, scrubRule(36)).filter(p => viewClear(p.position.x, p.position.z))
        const trees = buildConifers(viewer, [...spruce, ...scrub], {kind: 'spruce', height: 10, snow: 0.6, snowLine: 10.5, variants: 5, seed: 3, tint: [0.85, 1, 0.9]})

        // golden grass and flowers
        const tuftPts = scatterOnTerrain(terrain, {count: 6000, seed: 21, density: grass(terrain), scale: [0.7, 1.3], tries: 6})
        const tufts = buildTufts(viewer, tuftPts, {base: '#4b5a22', tip: '#c9c46e', dry: '#dccb8e', dryShare: 0.3, blades: 80, width: 0.5, height: 0.38, seed: 4}, 'Alpine grass')
        const flowerPts = scatterOnTerrain(terrain, {count: 900, seed: 22, density: flowers(terrain), scale: [0.6, 1.1], tries: 8})
        const flowerTufts = buildTufts(viewer, flowerPts, {base: '#3f5a22', tip: '#9cb050', blades: 30, flowers: ['#2846c8', '#3a5ae0', '#f0e8d8', '#f2c21a'], flowerCount: 10, width: 0.45, height: 0.3, seed: 9}, 'Alpine flowers')

        // rocks: boulders on the meadow and the scree, crags set into the gorge walls, snow on their tops
        const granite = (t: IObject3D | undefined, tint: [number, number, number], snow: number, minY = 10.5) => {
            if (!t) return
            forEachMesh(t as any, mesh => {
                const mt = mesh.material as PhysicalMaterial
                tintMaterial(mt, tint)
                if (!mt.userData.__snow) {
                    mt.userData.__snow = true
                    mt.registerMaterialExtensions([snowCapExtension(snow, minY)])
                }
            })
        }
        const [boulderT, mossSet, face1, face2] = await Promise.all(['boulder_01', 'rock_moss_set_01', 'rock_face_01', 'rock_face_02']
            .map(id => loadTemplate(viewer, worldAsset(id))))
        granite(boulderT, [0.85, 0.87, 0.92], 0.8)
        granite(face1, [0.7, 0.74, 0.82], 0.8)
        granite(face2, [0.7, 0.74, 0.82], 0.8)
        granite(mossSet, [0.85, 0.85, 0.85], 0.5)
        const rocks: Placement[] = scatterOnTerrain(terrain, {count: 34, seed: 31, density: boulders(terrain), spacing: 2.2, scale: [0.5, 1.6], sink: 0.25, align: 0.4})
        if (boulderT) instance(viewer, boulderT, rocks, 'Boulders')
        if (mossSet) {
            ;['rock01', 'rock02', 'rock03', 'rock05'].forEach((k, i) => {
                const part = pickPart(mossSet, 'rock_moss_set_01_' + k)
                if (part) instance(viewer, part, scatterOnTerrain(terrain, {count: 10, seed: 40 + i, density: boulders(terrain), spacing: 2.5, scale: [0.6, 1.2], sink: 0.15, align: 0.6}), 'Stones ' + k)
            })
        }
        const crags = gorgeCrags(terrain.height, GORGE.nearest(site.center.x, site.center.z).s).filter(c => Math.abs(c.position.x) < SIZE / 2 - 1.5 && Math.abs(c.position.z) < SIZE / 2 - 1.5)
        const cragT = [face1, face2]
        for (const k of [0, 1]) {
            const t = cragT[k]
            const ps = crags.filter(c => c.kind === k)
            if (t && ps.length) instance(viewer, t, ps.map(c => ({position: c.position, rotationY: c.rotationY, scale: c.scale * (k ? 1.4 : 1)})), 'Gorge crags ' + k)
        }
        // the horn's faces: rock slopes (scans) set into the heightfield, facing out, grey gneiss with snow on top
        const [slope] = await Promise.all(['mountainside'].map(id => loadTemplate(viewer, worldAsset(id))))
        if (slope) {
            granite(slope, [0.62, 0.68, 0.82], 0.85, 13)
            const r = rng(4)
            const ps: Placement[] = []
            const nrm = new Vector3()
            for (let i = 0; i < 400 && ps.length < 11; i++) {
                const a = r() * 6.28, dd = 3 + 7 * r()
                const x = PEAK.x + Math.cos(a) * dd, z = PEAK.z + Math.sin(a) * dd
                if (Math.abs(x) > SIZE / 2 - 3 || Math.abs(z) > SIZE / 2 - 3) continue
                const y = terrain.height(x, z)
                terrain.normalAt(x, z, nrm)
                if (y < 12.5 || y > 16.5 || nrm.y > 0.8 || ps.some(p => p.position.distanceTo(new Vector3(x, y, z)) < 4.5)) continue
                ps.push({position: new Vector3(x, y - 3.8 - 1.2 * r(), z), rotationY: Math.atan2(nrm.x, nrm.z) + (r() - 0.5) * 0.5, scale: 0.55 + 0.3 * r()})
            }
            instance(viewer, slope, ps, 'Horn faces')
        }
        // the land round the tile, for the eye-level views: the tile's own ground runs on (the natural ground,
        // without the road and the gorge), rises into wooded slopes and then into high ranges a few km off
        const noise = new Noise2(91)
        const edgeDist = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - SIZE / 2), Math.max(0, Math.abs(z) - SIZE / 2))
        const near = (x: number, z: number) => {
            const cx = Math.max(-SIZE / 2, Math.min(SIZE / 2, x)), cz = Math.max(-SIZE / 2, Math.min(SIZE / 2, z))
            // right at the edge the tile's own (eroded) surface, then the same landform (road and gorge included)
            const e = edgeDist(x, z)
            const t = smoothstep(0, 2, e)
            return terrain.height(cx, cz) * (1 - t) + height(x, z) * t
        }
        const far = (x: number, z: number) => {
            const d = Math.hypot(x, z)
            const wx = x + 300 * noise.fbm(x * 0.0006, z * 0.0006, 3), wz = z + 300 * noise.fbm(x * 0.0006 + 7, z * 0.0006, 3)
            const ridge = noise.ridged(wx * 0.0006 + 3, wz * 0.0006, 5)
            const massif = (900 * Math.pow(ridge, 1.25) + 250 * noise.fbm(wx * 0.0012, wz * 0.0012 + 4, 4)) * smoothstep(600, 2600, d)
            const hills = 150 * Math.pow(noise.ridged(wx * 0.0028, wz * 0.0028 + 5, 4), 1.2) * smoothstep(70, 450, d)
            const floor = baseHeight(Math.sign(x) * Math.min(Math.abs(x), 60), Math.sign(z) * Math.min(Math.abs(z), 60)) + 0.04 * Math.max(0, d - 60)
            return floor + hills + massif
        }
        const vista = buildVista(viewer, {tileSize: SIZE, near, far, blend: 120, extent: 7000, res: 360, sink: 0.05, name: 'Alpine vista', color: /* glsl */`
    float slope = 1.0 - wn.y;
    float big = n_fbm(wp.xz * 0.004, 3);
    vec3 grassC = mix(vec3(0.16, 0.14, 0.055), vec3(0.09, 0.11, 0.045), smoothstep(-0.2, 0.4, n_fbm(wp.xz * 0.01, 3)));
    grassC *= 0.75 + 0.5 * (n_fbm(wp.xz * 0.6, 3) * 0.5 + 0.5);
    // forest: dark crowns with lighter gaps, in stands that thin out up the slopes
    float crowns = n_snoise(wp.xz * 0.12) * 0.5 + 0.5;
    crowns = mix(crowns, 0.5, clamp(fwidth(wp.x) * 0.15, 0.0, 1.0));
    vec3 forestC = mix(vec3(0.008, 0.016, 0.012), vec3(0.025, 0.045, 0.028), crowns);
    vec3 rockC = vec3(0.17, 0.17, 0.18) * (0.75 + 0.4 * n_fbm(vec2(wp.x + wp.z, wp.y) * 0.02, 4));
    vec3 snowC = vec3(0.72, 0.75, 0.8);
    float tl = 330.0 + 80.0 * big;
    float forest = smoothstep(-0.25, 0.15, n_fbm(wp.xz * 0.006 + 5.0, 3) + 0.3 * smoothstep(40.0, 120.0, edgeD))
        * (1.0 - smoothstep(tl - 60.0, tl, wp.y)) * (1.0 - smoothstep(0.45, 0.7, slope)) * smoothstep(8.0, 30.0, edgeD);
    col = mix(grassC, forestC, forest);
    col = mix(col, rockC, smoothstep(0.32, 0.55, slope));
    float line = 480.0 + 120.0 * big;
    // snow lies on the benches and in the gullies, rock shows on the ribs and the steep walls
    float gully = n_fbm(vec2(atan(wp.z, wp.x) * 220.0, wp.y * 0.012), 4);
    float snowSlope = 1.0 - smoothstep(0.35 + 0.25 * gully, 0.65 + 0.2 * gully, slope);
    float snow = smoothstep(line, line + 80.0, wp.y + 60.0 * gully) * snowSlope;
    col = mix(col, rockC * 1.2, smoothstep(line - 150.0, line, wp.y) * smoothstep(0.2, 0.4, slope));
    col = mix(col, snowC * (0.85 + 0.15 * gully), snow);
    // near the tile: its own snow line
    col = mix(col, snowC, smoothstep(12.5, 15.0, wp.y) * (1.0 - smoothstep(60.0, 120.0, edgeD)) * (1.0 - smoothstep(0.3, 0.5, slope)));
`})
        vista.fog.vsFogColor.value.setRGB(0.55, 0.68, 0.9)
        vista.fog.vsFogDensity.value = 0.00034
        // far trees on the slopes round the tile (opaque tiers, cheap)
        {
            const r = rng(17)
            const ps: Placement[] = []
            for (let i = 0; i < 30000 && ps.length < 1800; i++) {
                const x = (r() - 0.5) * 480, z = (r() - 0.5) * 480
                const e = edgeDist(x, z)
                if (e < 10 || e > 220) continue
                const f = noise.fbm(x * 0.03 + 4, z * 0.03, 3)
                if (r() > smoothstep(-0.1, 0.3, f) * (1 - smoothstep(80, 220, e) * 0.5)) continue
                const y = near(x, z) * (1 - smoothstep(0, 120, e)) + far(x, z) * smoothstep(0, 120, e)
                if (y > 120) continue
                ps.push({position: new Vector3(x, y - 0.2, z), rotationY: r() * 6.28, scale: 0.7 + 0.7 * r()})
            }
            buildConifers(viewer, ps, {kind: 'spruce', height: 11, lod: true, variants: 3, seed: 8, name: 'Far spruces'}).meshes.forEach(m => farTrees.push(m))
            // grass on the ground just outside the tile, so the meadow runs on
            const gs: Placement[] = []
            for (let i = 0; i < 40000 && gs.length < 3500; i++) {
                const x = (r() - 0.5) * (SIZE + 50), z = (r() - 0.5) * (SIZE + 50)
                const e = edgeDist(x, z)
                if (e < 0.3 || e > 24) continue
                if (ROAD.nearest(x, z, 4).d < ROAD_HALF || GORGE.nearest(x, z, 4).d < 3) continue
                const t = smoothstep(0, 120, e)
                gs.push({position: new Vector3(x, near(x, z) * (1 - t) + far(x, z) * t, z), rotationY: r() * 6.28, scale: 0.7 + 0.6 * r()})
            }
            farTrees.push(buildTufts(viewer, gs, {base: '#4b5a22', tip: '#c9c46e', dry: '#dccb8e', dryShare: 0.3, blades: 80, width: 0.5, height: 0.38, seed: 4}, 'Vista grass').mesh)
        }

        // late morning: the sun from the front left, high enough to reach the gorge floor
        const sun0 = {azimuth: 148, elevation: 38}
        await stageWorld(viewer, rig, {
            sky: 'kloofendal_48d_partly_cloudy_puresky',
            skyLight: {ground: 0.3, tint: [0.95, 0.95, 0.95], saturation: 0.7},
            fill: 0.14,
            background: 'studio',
            sun: {enabled: true, azimuth: sun0.azimuth, elevation: sun0.elevation, intensity: 7.5, kelvin: 5700, shadowMapSize: 4096},
            fit: {center: [0, 6, 0], radius: SIZE * 0.78},
            exposure: 1.5,
            grade: {shadows: [0.94, 0.98, 1.08], highlights: [1.04, 1.0, 0.95], saturation: 1.08},
            vignette: 0.1,
            dof: {range: 0.6, near: 0.06, far: 0.14},
            plugins: {
                ssgi: {intensity: 3.2, rayCount: 4, stepCount: 16, autoRadius: false, objectRadius: 6, falloff: 0, tolerance: 1},
                ssr: {intensity: 0.8, rayCount: 1, stepCount: 16},
                bloom: {threshold: 3, intensity: 0.04},
                progressiveFrames: 64,
            },
        })
        cameraRange(viewer, 0.08, 12000)

        // the sky views show the land round the tile and hide the cut faces; the diorama shows the tile alone
        let skyMode = false
        const mode = (sky: boolean) => {
            skyMode = sky
            vista.mesh.visible = sky
            farTrees.forEach(t => t.visible = sky)
            creekOut.mesh.visible = sky
            faces.mesh.visible = !sky
            faces.base.visible = !sky
            backdrop(viewer, sky ? 'sky' : 'studio', sky ? timeBg : 0.8)
            // the studio view gets a brighter fill, so the cut face away from the sun is not black
            viewer.scene.environmentIntensity = sky ? timeFill : timeFill * 2.5
        }
        // the high Switchbacks view looks down onto ground that fills the frame: every SSGI ray marches its full
        // length there, so it traces two rays instead of four (the budget is 33 ms a frame)
        const ssgiPass = viewer.getPlugin(SSGIPlugin)?.pass as any
        const cam = (sky: boolean, p: [number, number, number], t: [number, number, number], fov: number, rays = 4) => () => {
            mode(sky)
            if (ssgiPass) { ssgiPass.rayCount = rays; ssgiPass.setDirty?.() }
            setCamera(viewer, p, t, fov)
        }
        const views: Record<string, () => void> = {'Diorama': cam(false, [58, 52, 66], [0, 3, -1], 33)}
        for (const k in shots) views[k] = cam(true, shots[k].cam, shots[k].target, shots[k].fov, k === 'Switchbacks' ? 2 : 4)
        views['Diorama']()

        const setTime = async(p: TimePreset & {fog: [number, number, number]}) => {
            timeFill = p.fill
            timeBg = p.backgroundIntensity ?? 1
            vista.fog.vsFogColor.value.setRGB(...p.fog)
            await applyTime(viewer, rig, p, sun0)
            viewer.scene.environmentIntensity = skyMode ? timeFill : timeFill * 2.5
            viewer.scene.backgroundIntensity = skyMode ? timeBg : 0.8
        }
        const times = {
            'Late morning': () => setTime({fog: [0.55, 0.68, 0.9], sun: {azimuth: 148, elevation: 38, intensity: 7.5, kelvin: 5700}, fill: 0.14, sky: 'kloofendal_48d_partly_cloudy_puresky', exposure: 1.5, backgroundIntensity: 0.8}),
            'Alpenglow': () => setTime({fog: [0.75, 0.62, 0.62], sun: {azimuth: 165, elevation: 9, intensity: 6, kelvin: 3100}, fill: 0.1, sky: 'kiara_8_sunset', exposure: 1.85, backgroundIntensity: 0.7}),
        }
        const animate = (t: number) => {
            creek.uniforms.waterTime.value = t
            creekOut.uniforms.waterTime.value = t
            tarn.uniforms.waterTime.value = t
        }
        animate(0)
        const camera = (t: number) => {
            const k = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 / 40)
            mode(false)
            if (ssgiPass) ssgiPass.rayCount = 4
            const a = 0.6 + 0.5 * k
            setCamera(viewer, [Math.cos(a) * 70, 44, Math.sin(a) * 70], [0, 3.5, 0], 33)
        }
        const tris = terrain.mesh.geometry.index!.count / 3 + faces.triangles + trees.triangles + tufts.triangles + flowerTufts.triangles + batch.triangles + vista.triangles
        console.log(`alpine: built in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(tris / 1e6).toFixed(2)} M triangles (trees ${(trees.triangles / 1e6).toFixed(2)} M, props ${(batch.triangles / 1e3).toFixed(0)} k)`)
        ;(viewer as any).__alpine = {terrain, site, bridge, trees, faces, vista, materials: m}
        return {animate, camera, views, times,
            credits: 'Terrain, rock strata, snow, water, spruces, grass, bridge, hut and road furniture generated at runtime. Rock scans, ground textures and skies: Poly Haven (CC0). Noise and material library after "Golden Temple" by Leon Lin (MIT).'}
    },
}

/** Glints on the snow layer of the terrain: rare cells that flash as the view moves. */
const SNOW_SPARKLE: MaterialExtension = {
    shaderExtender: (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    {
        vec3 cell = floor(vTerrainPos * 55.0);
        vec3 vd = normalize(cameraPosition - vTerrainPos);
        float hsh = fract(sin(dot(cell + floor(vd * 9.0), vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        float glint = step(0.9985, hsh) * terrainW.z * smoothstep(40.0, 10.0, length(cameraPosition - vTerrainPos));
        totalEmissiveRadiance += vec3(1.0, 0.98, 0.95) * glint * 2.0;
    }
`)
    },
    computeCacheKey: () => 'snow-sparkle-1',
    isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
}
