import {Box3, Color, IObject3D, InstancedMesh, Matrix4, Mesh, Object3D, PhysicalMaterial, Quaternion, ThreeViewer, Vector3} from 'threepipe'
import {asset} from './assets'
import {rng} from './noise'
import type {Terrain} from './terrain'

/**
 * Instanced placement of model files over a terrain (or anywhere): each mesh of the model becomes one
 * InstancedMesh, so a thousand rocks cost one draw call per mesh of the rock.
 */

const cache = new Map<string, Promise<IObject3D | undefined>>()

/** Loads a model file once; the result is a template, never added to the scene. */
export function loadTemplate(viewer: ThreeViewer, url: string): Promise<IObject3D | undefined> {
    let p = cache.get(url)
    if (!p) {
        p = viewer.import<IObject3D>(asset(url)).then((o) => {
            if (!o?.isObject3D) return undefined
            o.updateMatrixWorld(true)
            return o
        }).catch((e) => {
            console.error('scatter: could not load', url, e)
            return undefined
        })
        cache.set(url, p)
    }
    return p
}

export interface Placement {
    position: Vector3
    rotationY?: number
    /** Uniform scale, or per axis. */
    scale?: number | Vector3
    /** Tilt to follow the ground normal (0 upright, 1 fully aligned). */
    align?: number
    normal?: Vector3
    /** Extra rotation applied before the yaw (e.g. to lay a cliff on its side). */
    pre?: Quaternion
}

export interface InstancedSet {
    root: Object3D
    meshes: InstancedMesh[]
    count: number
}

const _m = new Matrix4(), _q = new Quaternion(), _qa = new Quaternion(), _s = new Vector3(), _up = new Vector3(0, 1, 0)

/** One InstancedMesh per mesh of the template, with the placements as instances. */
export function instance(viewer: ThreeViewer, template: IObject3D, placements: Placement[], name: string,
    o: {castShadow?: boolean, receiveShadow?: boolean, tint?: (material: PhysicalMaterial) => void} = {}) {
    const root = new Object3D()
    root.name = name
    const meshes: InstancedMesh[] = []
    const rootInv = new Matrix4().copy(template.matrixWorld).invert()
    const instanceMatrices = placements.map((p) => {
        _q.identity()
        if (p.align && p.normal) _qa.setFromUnitVectors(_up, p.normal).slerp(new Quaternion(), 1 - p.align)
        else _qa.identity()
        _q.setFromAxisAngle(_up, p.rotationY ?? 0)
        if (p.pre) _q.multiply(p.pre)
        _q.premultiply(_qa)
        if (typeof p.scale === 'number' || p.scale === undefined) _s.setScalar(p.scale ?? 1)
        else _s.copy(p.scale)
        return new Matrix4().compose(p.position, _q, _s)
    })
    template.traverse((c: any) => {
        if (!c.isMesh || !c.geometry) return
        const local = new Matrix4().multiplyMatrices(rootInv, c.matrixWorld)
        const im = new InstancedMesh(c.geometry, c.material, placements.length)
        im.name = name + ':' + (c.name || 'mesh')
        instanceMatrices.forEach((m, i) => im.setMatrixAt(i, _m.multiplyMatrices(m, local)))
        im.instanceMatrix.needsUpdate = true
        im.castShadow = o.castShadow ?? true
        im.receiveShadow = o.receiveShadow ?? true
        im.computeBoundingSphere()
        im.computeBoundingBox?.()
        if (o.tint && c.material) o.tint(c.material)
        meshes.push(im)
        root.add(im)
    })
    viewer.scene.addObject(root as any)
    return {root, meshes, count: placements.length} as InstancedSet
}

/** A copy of a whole model (not instanced) for hero pieces; materials are shared with the template. */
export function place(viewer: ThreeViewer, template: IObject3D, p: Placement, name: string) {
    const o = template.clone(true) as any as Object3D
    o.name = name
    o.position.copy(p.position)
    o.rotation.set(0, p.rotationY ?? 0, 0)
    if (p.pre) o.quaternion.multiply(p.pre)
    if (typeof p.scale === 'number') o.scale.setScalar(p.scale)
    else if (p.scale) o.scale.copy(p.scale)
    o.traverse((c: any) => {
        if (c.isMesh) {
            c.castShadow = true
            c.receiveShadow = true
        }
        if (c.isLight) c.visible = false
    })
    return viewer.scene.addObject(o as any) as IObject3D
}

export interface ScatterRule {
    count: number
    seed: number
    /** Area to sample, [minX, minZ, maxX, maxZ]. Defaults to the terrain. */
    area?: [number, number, number, number]
    /** Probability [0, 1] to keep a candidate at x, z (masks, slope, height). */
    density: (x: number, z: number, h: number, slope: number) => number
    /** Minimum distance between instances of this rule. */
    spacing?: number
    scale?: [number, number]
    /** Sink into the ground, in units of scale. */
    sink?: number
    align?: number
    /** Candidates tried per placed instance. */
    tries?: number
}

/** Poisson-ish rejection sampling on the terrain surface. */
export function scatterOnTerrain(terrain: Terrain, r: ScatterRule): Placement[] {
    const rand = rng(r.seed)
    const half = terrain.size / 2
    const [x0, z0, x1, z1] = r.area ?? [-half, -half, half, half]
    const out: Placement[] = []
    const sp2 = (r.spacing ?? 0) ** 2
    const maxTries = r.count * (r.tries ?? 30)
    const n = new Vector3()
    for (let t = 0; t < maxTries && out.length < r.count; t++) {
        const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0)
        const h = terrain.height(x, z)
        terrain.normalAt(x, z, n)
        const slope = 1 - n.y
        if (rand() > r.density(x, z, h, slope)) continue
        if (sp2 > 0 && out.some(p => (p.position.x - x) ** 2 + (p.position.z - z) ** 2 < sp2)) continue
        const [s0, s1] = r.scale ?? [1, 1]
        const s = s0 + (s1 - s0) * rand()
        out.push({
            position: new Vector3(x, h - (r.sink ?? 0) * s, z),
            rotationY: rand() * Math.PI * 2,
            scale: s,
            align: r.align ?? 0,
            normal: n.clone(),
        })
    }
    return out
}

/** Multiplies a material's color: tints scans per scene (e.g. warmer sandstone). */
export function tintMaterial(m: PhysicalMaterial, c: [number, number, number], roughness?: number) {
    if (!m?.color) return
    if (m.userData.__tinted) return
    m.userData.__tinted = true
    m.color.multiply(new Color(...c))
    if (roughness !== undefined) m.roughness = roughness
    m.setDirty?.()
}

export function forEachMesh(o: Object3D, f: (m: Mesh) => void) {
    o.traverse((c: any) => c.isMesh && f(c))
}

/**
 * One named part of a kit file (props stored side by side, e.g. `metal_trash_can` next to `metal_trash_can_rust`),
 * as a template with its bottom centre at the origin.
 */
export function pickPart(template: IObject3D, name: string): IObject3D | undefined {
    let node: any
    template.traverse((o: any) => {
        if (!node && o.name === name) node = o
    })
    if (!node) {
        console.warn('scatter: no part', name)
        return undefined
    }
    const copy = node.clone(true) as Object3D
    copy.position.set(0, 0, 0)
    copy.rotation.set(0, 0, 0)
    copy.scale.set(1, 1, 1)
    const wrapper = new Object3D()
    wrapper.add(copy)
    wrapper.updateMatrixWorld(true)
    const box = new Box3().setFromObject(copy)
    const c = box.getCenter(new Vector3())
    copy.position.set(-c.x, -box.min.y, -c.z)
    wrapper.updateMatrixWorld(true)
    return wrapper as any as IObject3D
}
