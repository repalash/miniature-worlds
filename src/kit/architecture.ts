import {
    BoxGeometry,
    ExtrudeGeometry,
    Shape,
    BufferGeometry,
    Color,
    ColorRepresentation,
    Matrix4,
    mergeGeometries,
    mergeVertices,
    Mesh,
    Object3D,
    PhysicalMaterial,
    ThreeViewer,
    Vector3,
} from 'threepipe'
import {polyHavenTexture} from './helpers'
import {rng} from './noise'

/**
 * Runtime architecture for the world scenes: buildings made of boxes with thickness (thin planes send no bounce
 * light from their back and leak light), textured with scanned Poly Haven surfaces in world-scaled UVs, and merged
 * into one mesh per material, so a street of facades is a handful of draw calls.
 */

export interface SurfaceOptions {
    tint?: ColorRepresentation
    roughness?: number
    normalScale?: number
    metalness?: number
}

/** A PhysicalMaterial with a Poly Haven texture set; UVs are expected in texture tiles (see BoxBatch). */
export async function surface(viewer: ThreeViewer, id: string | null, o: SurfaceOptions = {}) {
    const m = new PhysicalMaterial({color: new Color(o.tint ?? '#ffffff'), roughness: o.roughness ?? 1, metalness: o.metalness ?? 0})
    m.name = id ?? 'plain'
    if (id) {
        const t = await polyHavenTexture(viewer, id, [1, 1])
        if (t.map) m.map = t.map
        if (t.roughnessMap) m.roughnessMap = t.roughnessMap
        if (t.normalMap) {
            m.normalMap = t.normalMap
            m.normalScale.setScalar(o.normalScale ?? 1)
        }
    }
    m.setDirty?.()
    return m
}

const _v = new Vector3(), _n = new Vector3()

/**
 * Collects boxes per material and merges them. UVs are planar per face from the box position in the batch's
 * frame, divided by the material's tile size, so the texture runs on across neighbouring boxes.
 */
export class BoxBatch {
    private readonly parts = new Map<PhysicalMaterial, BufferGeometry[]>()
    private readonly tiles = new Map<PhysicalMaterial, number>()

    /** Tile size in meters for a material (default 2). */
    tile(m: PhysicalMaterial, meters: number) {
        this.tiles.set(m, meters)
        return m
    }

    /** A box of the given size, centered at `center`, rotated about y by `rotY`. */
    box(m: PhysicalMaterial, size: [number, number, number], center: [number, number, number], rotY = 0) {
        const g = new BoxGeometry(...size)
        g.applyMatrix4(new Matrix4().makeRotationY(rotY).setPosition(...center))
        return this.add(m, g)
    }

    /** Any geometry with normals, already placed in the batch's frame; gets planar UVs per face like a box. */
    add(m: PhysicalMaterial, g: BufferGeometry) {
        // mergeGeometries needs all parts indexed (boxes are, extrusions are not).
        if (!g.index) g = mergeVertices(g)
        const tile = this.tiles.get(m) ?? 2
        const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv
        for (let i = 0; i < pos.count; i++) {
            _v.fromBufferAttribute(pos, i)
            _n.fromBufferAttribute(nor, i)
            const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z)
            let u: number, v: number
            if (ax >= ay && ax >= az) { u = _v.z * -Math.sign(_n.x); v = _v.y }
            else if (ay >= az) { u = _v.x; v = _v.z * -Math.sign(_n.y) }
            else { u = _v.x * Math.sign(_n.z); v = _v.y }
            uv.setXY(i, u / tile, v / tile)
        }
        let list = this.parts.get(m)
        if (!list) this.parts.set(m, list = [])
        list.push(g)
        return g
    }

    /** Merges everything into meshes under `parent` (or a new group added to the scene). */
    build(viewer: ThreeViewer, name: string, parent?: Object3D) {
        const group = parent ?? new Object3D()
        group.name = name
        for (const [m, list] of this.parts) {
            const g = mergeGeometries(list, false)
            if (!g) continue
            g.computeBoundingSphere()
            const mesh = new Mesh(g, m)
            mesh.name = `${name}: ${m.name}`
            mesh.castShadow = true
            mesh.receiveShadow = true
            group.add(mesh)
            list.forEach(l => l.dispose())
        }
        this.parts.clear()
        if (!parent) viewer.scene.addObject(group as any)
        return group
    }
}

export interface FacadeSpec {
    /** Facade length along its local x, building depth behind it (local -z), storey count and heights. */
    length: number
    depth: number
    storeys: number
    storeyHeight?: number
    groundHeight?: number
    /** Window bay width. */
    bay?: number
    wall: PhysicalMaterial
    trim: PhysicalMaterial
    glass: PhysicalMaterial
    frame: PhysicalMaterial
    /**
     * Ground floor: shop windows, doors, a plain wall with small windows, or an arcade (a portico: columns on the
     * facade line, the shop fronts `arcadeDepth` behind them, the upper floors overhead).
     */
    ground?: 'shops' | 'doors' | 'plain' | 'arcade'
    arcadeDepth?: number
    /** Window shutters (one material per building), or none. */
    shutters?: PhysicalMaterial
    /** Curtain fabrics seen through the windows (one picked per window), in front of a dark interior. */
    curtains?: PhysicalMaterial[]
    /** The room behind the glass; with several, one is picked per window (e.g. some lit at night). */
    interior?: PhysicalMaterial | PhysicalMaterial[]
    /** A pitched tile roof over the whole depth instead of a flat roof with a parapet. */
    roof?: {material: PhysicalMaterial, pitch?: number}
    /** Probability of a shutter pair being closed. */
    closed?: number
    /** Window balconies on these storeys (1-based). */
    balconies?: number[]
    seed?: number
}

/**
 * One building, its street facade in the local x-y plane facing +z (z = 0 is the facade line), the body
 * behind it. Piers, spandrels and lintels frame recessed windows; a string course over the ground floor and a
 * cornice on top project from the wall and catch the light.
 */
export function facade(b: BoxBatch, s: FacadeSpec, frame: Matrix4) {
    const r = rng(s.seed ?? 1)
    const sh = s.storeyHeight ?? 3.2, gh = s.groundHeight ?? 4.2, bay = s.bay ?? 3
    const H = gh + s.storeys * sh
    const bays = Math.max(1, Math.round(s.length / bay))
    const bw = s.length / bays
    const L = s.length
    const recess = 0.32
    const add = (m: PhysicalMaterial, size: [number, number, number], c: [number, number, number]) => {
        const g = b.box(m, size, c)
        g.applyMatrix4(frame)
        return g
    }
    const arcade = s.ground === 'arcade'
    if (arcade) {
        // Upper floors over the portico, the shop block behind it, columns with bases and capitals on the facade line.
        const ad = s.arcadeDepth ?? 3.6
        add(s.wall, [L, H - gh, s.depth - recess], [L / 2, gh + (H - gh) / 2, -recess - (s.depth - recess) / 2])
        add(s.wall, [L, gh, s.depth - ad], [L / 2, gh / 2, -ad - (s.depth - ad) / 2])
        add(s.trim, [L, 0.06, ad], [L / 2, 0.03, -ad / 2])
        for (let i = 0; i <= bays; i++) {
            const x = Math.min(L - 0.35, Math.max(0.35, i * bw))
            add(s.wall, [0.62, gh - 0.7, 0.62], [x, 0.35 + (gh - 0.7) / 2, -0.4])
            add(s.trim, [0.8, 0.35, 0.8], [x, 0.175, -0.4])
            add(s.trim, [0.84, 0.3, 0.84], [x, gh - 0.2, -0.4])
        }
        // Beam over the columns.
        add(s.trim, [L, 0.4, 0.8], [L / 2, gh - 0.2, -0.4])
        for (let i = 0; i < bays; i++) {
            const cx = (i + 0.5) * bw, w = bw - 1.4
            const door = i % 3 === 1
            add(door ? s.frame : s.glass, [w, door ? 2.6 : 2.9, 0.06], [cx, door ? 1.36 : 1.55, -ad + 0.04])
            add(s.frame, [w + 0.12, 0.1, 0.12], [cx, door ? 2.7 : 3.05, -ad + 0.06])
        }
    } else {
        // The body, set back so the openings are deep; its front is the back of every window recess.
        add(s.wall, [L, H, s.depth - recess], [L / 2, H / 2, -recess - (s.depth - recess) / 2])
        // Plinth.
        add(s.trim, [L + 0.1, 0.5, recess + 0.06], [L / 2, 0.25, -recess / 2 + 0.03])
    }
    // Ground floor openings.
    const groundPier = 0.7
    for (let i = 0; i <= bays && !arcade; i++) {
        const x = i * bw
        const w = i === 0 || i === bays ? groundPier / 2 : groundPier
        add(s.wall, [w, gh - 0.5, recess], [Math.min(L - w / 2, Math.max(w / 2, x)), 0.5 + (gh - 0.5) / 2, -recess / 2])
    }
    for (let i = 0; i < bays && !arcade; i++) {
        const x0 = i * bw + groundPier / 2, x1 = (i + 1) * bw - groundPier / 2, cx = (x0 + x1) / 2, w = x1 - x0
        const kind = s.ground ?? 'shops'
        const door = kind === 'doors' || (kind === 'shops' && i % 3 === 1)
        const top = door ? 2.6 : 3.1
        const sill = kind === 'plain' ? 1.4 : door ? 0.5 : 0.9
        // wall above and below the opening
        add(s.wall, [w, gh - top, recess], [cx, top + (gh - top) / 2, -recess / 2])
        if (sill > 0.5) add(s.wall, [w, sill - 0.5, recess], [cx, 0.5 + (sill - 0.5) / 2, -recess / 2])
        if (door) {
            add(s.frame, [Math.min(w, 1.6), top - 0.5, 0.08], [cx, 0.5 + (top - 0.5) / 2, -recess + 0.06])
        } else {
            add(s.glass, [w, top - sill, 0.04], [cx, sill + (top - sill) / 2, -recess + 0.1])
            add(s.frame, [w, 0.08, 0.12], [cx, sill + 0.04, -recess + 0.1])
            add(s.frame, [0.06, top - sill, 0.12], [cx, sill + (top - sill) / 2, -recess + 0.1])
        }
    }
    // String course above the ground floor.
    add(s.trim, [L + 0.3, 0.32, recess + 0.18], [L / 2, gh + 0.16, -recess / 2 + 0.09])

    // Upper storeys: full-height piers between bays, spandrel and lintel per window.
    const pier = Math.min(0.9, bw * 0.35), winW = bw - pier
    for (let i = 0; i <= bays; i++) {
        const x = i * bw
        const w = i === 0 || i === bays ? pier / 2 : pier
        add(s.wall, [w, H - gh - 0.32, recess], [Math.min(L - w / 2, Math.max(w / 2, x)), gh + 0.32 + (H - gh - 0.32) / 2, -recess / 2])
    }
    for (let st = 0; st < s.storeys; st++) {
        const sill = 0.85, head = 0.45
        for (let i = 0; i < bays; i++) {
            const cx = (i + 0.5) * bw
            // The first storey starts above the string course.
            const base = gh + st * sh + (st === 0 ? 0.32 : 0)
            add(s.wall, [winW, sill, recess], [cx, base + sill / 2, -recess / 2])
            const wy0 = base + sill, wy1 = gh + (st + 1) * sh - head
            add(s.wall, [winW, head, recess], [cx, wy1 + head / 2, -recess / 2])
            const h = wy1 - wy0
            // window: sill board, frame, glass
            add(s.trim, [winW + 0.16, 0.08, recess + 0.12], [cx, wy0 - 0.04, -recess / 2 + 0.06])
            if (s.interior) {
                const room = Array.isArray(s.interior) ? s.interior[Math.floor(r() * s.interior.length)] : s.interior
                add(room, [winW - 0.1, h - 0.1, 0.02], [cx, wy0 + h / 2, -recess + 0.02])
            }
            if (s.curtains?.length) {
                const c = s.curtains[Math.floor(r() * s.curtains.length)]
                const open = 0.15 + 0.3 * r()
                for (const e of [-1, 1]) add(c, [(winW - 0.12) * (0.5 - open / 2), h - 0.14, 0.02], [cx + e * (winW - 0.12) * (0.25 + open / 4), wy0 + h / 2, -recess + 0.05])
            }
            add(s.glass, [winW - 0.1, h - 0.1, 0.02], [cx, wy0 + h / 2, -recess + 0.12])
            add(s.frame, [winW, 0.07, 0.1], [cx, wy0 + h * 0.62, -recess + 0.14])
            add(s.frame, [0.06, h, 0.1], [cx, wy0 + h / 2, -recess + 0.14])
            for (const e of [-1, 1]) add(s.frame, [0.07, h, 0.12], [cx + e * (winW / 2 - 0.035), wy0 + h / 2, -recess + 0.12])
            add(s.frame, [winW, 0.07, 0.12], [cx, wy1 - 0.035, -recess + 0.12])
            if (s.shutters) {
                const closed = r() < (s.closed ?? 0.25)
                const sw = winW / 2
                for (const e of [-1, 1]) {
                    if (closed) add(s.shutters, [sw - 0.02, h, 0.05], [cx + e * sw / 2, wy0 + h / 2, -recess + 0.2])
                    else add(s.shutters, [sw * 0.92, h, 0.05], [cx + e * (winW / 2 + sw * 0.5), wy0 + h / 2, 0.03])
                }
            }
            if (s.balconies?.includes(st + 1) && i % 2 === 0) {
                add(s.trim, [winW + 0.6, 0.14, 0.9], [cx, wy0 - 0.07, 0.45])
                add(s.frame, [winW + 0.6, 0.05, 0.04], [cx, wy0 + 0.95, 0.88])
                for (let k = 0; k <= 8; k++) add(s.frame, [0.025, 0.95, 0.025], [cx - (winW + 0.6) / 2 + k * (winW + 0.6) / 8, wy0 + 0.475, 0.88])
            }
        }
        if (st < s.storeys - 1) add(s.trim, [L + 0.1, 0.14, recess + 0.08], [L / 2, gh + (st + 1) * sh - 0.07, -recess / 2 + 0.04])
    }
    // Cornice, then a pitched roof (ridge along the facade, gables at both ends) or a parapet.
    add(s.trim, [L + 0.5, 0.28, recess + 0.5], [L / 2, H + 0.14, -recess / 2 + 0.25])
    add(s.trim, [L + 0.7, 0.18, recess + 0.62], [L / 2, H + 0.37, -recess / 2 + 0.31])
    if (s.roof) {
        const pitch = s.roof.pitch ?? 0.5, half = s.depth / 2, rise = half * Math.tan(pitch), top = H + 0.46
        for (const side of [1, -1]) {
            const g = b.box(s.roof.material, [L + 0.5, 0.18, half / Math.cos(pitch) + 0.5], [0, 0, 0])
            g.rotateX(side * pitch)
            g.translate(L / 2, top + rise / 2, -half + side * half / 2)
            g.applyMatrix4(frame)
        }
        const gable = new Shape()
        gable.moveTo(0, 0)
        gable.lineTo(s.depth, 0)
        gable.lineTo(half, rise)
        gable.closePath()
        for (const x of [0, L - 0.3]) {
            const g = new ExtrudeGeometry(gable, {depth: 0.3, bevelEnabled: false})
            g.rotateY(Math.PI / 2)
            g.translate(x, top, 0)
            b.add(s.wall, g).applyMatrix4(frame)
        }
    } else add(s.wall, [L, 0.9, 0.3], [L / 2, H + 0.9, -0.15])
    return H
}

/** Frame for a facade: origin on the facade line, facing direction `rotY` (0 = +z). */
export const facadeFrame = (x: number, z: number, rotY: number) => new Matrix4().makeRotationY(rotY).setPosition(x, 0, z)
