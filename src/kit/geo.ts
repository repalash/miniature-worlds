import {
    BoxGeometry,
    BufferAttribute,
    BufferGeometry,
    CylinderGeometry,
    ExtrudeGeometry,
    LatheGeometry,
    Matrix4,
    mergeGeometries,
    Mesh,
    Object3D,
    Path,
    PhysicalMaterial,
    Shape,
    SphereGeometry,
    ThreeViewer,
    Vector2,
    Vector3,
    toCreasedNormals,
} from 'threepipe'
import {Noise2} from './noise'

/**
 * Geometry for hand-built lime architecture: boxes with rounded edges (the wash is thick and rounds every arris),
 * walls with soft-edged openings (a shape with holes, extruded with a bevel), barrel vaults, domes and lathe
 * profiles. Edges and corners get a slight wobble from noise in world space, so no wall is ruler-straight.
 * Everything is collected per material into a {@link Batch} and merged.
 */

const _v = new Vector3(), _n = new Vector3(), _c = new Vector3()
const noise = new Noise2(41)

/**
 * A box w x h x d centred at the origin with edges rounded to radius r (k segments per rounded edge): the grid of
 * a segmented box, its outer rings moved to the edges and projected onto the rounded shape (as three's
 * RoundedBoxGeometry does).
 */
export function softBox(w: number, h: number, d: number, r = 0.08, k = 2): BufferGeometry {
    r = Math.max(0.005, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001))
    const seg = 2 * k + 1
    const g = new BoxGeometry(1, 1, 1, seg, seg, seg)
    const pos = g.attributes.position, nor = g.attributes.normal
    const half = new Vector3(w / 2, h / 2, d / 2)
    const inner = half.clone().subScalar(r)
    // grid index along an axis -> pre-projection coordinate: ring 0 and seg sit on the faces, the middle segment is the flat part
    const remap = (t: number, hh: number, ii: number) => {
        const i = Math.round((t + 0.5) * seg) // 0..seg
        if (i === 0) return -hh
        if (i === seg) return hh
        // rings 1..k on the - side, k+1..2k on the + side
        if (i <= k) return -ii - r * (k - i) / k
        return ii + r * (k - (seg - i)) / k
    }
    for (let i = 0; i < pos.count; i++) {
        _v.set(remap(pos.getX(i), half.x, inner.x), remap(pos.getY(i), half.y, inner.y), remap(pos.getZ(i), half.z, inner.z))
        _c.set(Math.max(-inner.x, Math.min(inner.x, _v.x)), Math.max(-inner.y, Math.min(inner.y, _v.y)), Math.max(-inner.z, Math.min(inner.z, _v.z)))
        _n.subVectors(_v, _c)
        if (_n.lengthSq() < 1e-12) _n.set(nor.getX(i), nor.getY(i), nor.getZ(i))
        _n.normalize()
        _v.copy(_c).addScaledVector(_n, r)
        pos.setXYZ(i, _v.x, _v.y, _v.z)
        nor.setXYZ(i, _n.x, _n.y, _n.z)
    }
    g.deleteAttribute('uv')
    return g
}

/** Displaces vertices along their normals by noise of their world position (amp metres, freq per metre). */
export function wobble(g: BufferGeometry, amp: number, freq = 0.7) {
    if (amp <= 0) return g
    const pos = g.attributes.position, nor = g.attributes.normal
    for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i)
        _n.fromBufferAttribute(nor, i)
        const s = noise.noise(_v.x * freq + _v.y * 0.37 * freq, _v.z * freq - _v.y * 0.61 * freq)
        pos.setXYZ(i, _v.x + _n.x * s * amp, _v.y + _n.y * s * amp * 0.5, _v.z + _n.z * s * amp)
    }
    return g
}

/** Rectangle hole path (for shapes), x0..x1, y0..y1; arched top with `arch` = rise of a segmental arch. */
export function holePath(x0: number, x1: number, y0: number, y1: number, arch = 0): Path {
    const p = new Path()
    p.moveTo(x0, y0)
    p.lineTo(x1, y0)
    p.lineTo(x1, y1)
    if (arch > 0) {
        const w = (x1 - x0) / 2, cx = (x0 + x1) / 2
        // circle through the springing points and the crown
        const R = (w * w + arch * arch) / (2 * arch)
        const cy = y1 + arch - R
        const a0 = Math.atan2(y1 - cy, w), a1 = Math.PI - a0
        p.absarc(cx, cy, R, a0, a1, false)
    } else p.lineTo(x0, y1)
    p.lineTo(x0, y0)
    return p
}

/** Outline shape of a rectangle w x h with an optional segmental arched top (rise `arch`), origin bottom centre. */
export function archShape(w: number, h: number, arch = 0): Shape {
    const s = new Shape()
    s.moveTo(-w / 2, 0)
    s.lineTo(w / 2, 0)
    s.lineTo(w / 2, h)
    if (arch > 0) {
        const R = (w * w / 4 + arch * arch) / (2 * arch), cy = h + arch - R
        const a0 = Math.atan2(h - cy, w / 2)
        s.absarc(0, cy, R, a0, Math.PI - a0, false)
    } else s.lineTo(-w / 2, h)
    s.lineTo(-w / 2, 0)
    return s
}

/**
 * Extrudes a shape (in x-y, origin as drawn) by `depth` along +z with a rounded bevel of radius `bevel` (the bevel
 * grows the outline and shrinks the holes by `bevel`: shapes are drawn to the finished size and inset here).
 */
export function extrudeSoft(shape: Shape, depth: number, bevel = 0.06, curveSegments = 10, bevelSegments = 3): BufferGeometry {
    const g = new ExtrudeGeometry(shape, {
        depth: Math.max(0.001, depth - 2 * bevel),
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel * 0.9,
        bevelOffset: -bevel * 0.9,
        bevelSegments,
        curveSegments,
    })
    g.translate(0, 0, bevel)
    g.deleteAttribute('uv')
    // smooth normals over the bevel steps and the arcs, hard only at real corners
    return toCreasedNormals(g, 0.75)
}

/** A solid barrel vault: semicircular (or segmental) section of span w, rise, along z for `len`, sitting on y = 0. */
export function vault(w: number, rise: number, len: number, bevel = 0.08): BufferGeometry {
    const s = new Shape()
    const R = (w * w / 4 + rise * rise) / (2 * rise), cy = rise - R
    const a0 = Math.atan2(-cy, w / 2)
    s.moveTo(-w / 2, 0)
    s.lineTo(w / 2, 0)
    s.absarc(0, cy, R, a0, Math.PI - a0, false)
    s.lineTo(-w / 2, 0)
    const g = extrudeSoft(s, len, bevel, 16, 3)
    g.translate(0, 0, -len / 2)
    return g
}

/** A dome: hemisphere (scaled height `hk`) of radius r on y = 0. */
export function dome(r: number, hk = 1, seg = 32): BufferGeometry {
    const g = new SphereGeometry(r, seg, Math.round(seg / 3), 0, Math.PI * 2, 0, Math.PI / 2)
    g.scale(1, hk, 1)
    g.deleteAttribute('uv')
    return g
}

export function cylinder(rt: number, rb: number, h: number, seg = 24, open = false): BufferGeometry {
    const g = new CylinderGeometry(rt, rb, h, seg, 1, open)
    g.translate(0, h / 2, 0)
    g.deleteAttribute('uv')
    return g
}

/** Lathe of a profile [r, y][] around y. */
export function lathe(profile: [number, number][], seg = 24): BufferGeometry {
    const g = new LatheGeometry(profile.map(([r, y]) => new Vector2(Math.max(1e-4, r), y)), seg)
    g.deleteAttribute('uv')
    g.computeVertexNormals()
    return g
}

export function box(w: number, h: number, d: number): BufferGeometry {
    const g = new BoxGeometry(w, h, d)
    g.deleteAttribute('uv')
    return g
}

/** Matrix: rotation about y then translation. */
export const at = (x: number, y: number, z: number, ry = 0) => new Matrix4().makeRotationY(ry).setPosition(x, y, z)

/** Collects geometries per material (positions and normals only, procedural materials need no UVs) and merges them. */
export class Batch {
    private readonly parts = new Map<PhysicalMaterial, BufferGeometry[]>()
    triangles = 0

    add(m: PhysicalMaterial, g: BufferGeometry, matrix?: Matrix4, wobbleAmp = 0) {
        if (matrix) g.applyMatrix4(matrix)
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
        if (!g.index) {
            const n = g.attributes.position.count
            const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n)
            for (let i = 0; i < n; i++) idx[i] = i
            g.setIndex(new BufferAttribute(idx, 1))
        }
        if (wobbleAmp > 0) wobble(g, wobbleAmp)
        let list = this.parts.get(m)
        if (!list) this.parts.set(m, list = [])
        list.push(g)
        return g
    }

    build(viewer: ThreeViewer, name: string, o: {castShadow?: boolean} = {}) {
        const group = new Object3D()
        group.name = name
        for (const [m, list] of this.parts) {
            // keep each merged mesh under a few million vertices
            const chunks: BufferGeometry[][] = [[]]
            let count = 0
            for (const g of list) {
                if (count > 2e6) { chunks.push([]); count = 0 }
                chunks[chunks.length - 1].push(g)
                count += g.attributes.position.count
            }
            for (const chunk of chunks) {
                if (!chunk.length) continue
                const g = mergeGeometries(chunk, false)
                if (!g) { console.warn('geo: merge failed', name, m.name); continue }
                g.computeBoundingSphere()
                g.computeBoundingBox()
                this.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3
                const mesh = new Mesh(g, m)
                mesh.name = `${name}: ${m.name}`
                mesh.castShadow = o.castShadow ?? true
                mesh.receiveShadow = true
                group.add(mesh)
                chunk.forEach(c => c.dispose())
            }
        }
        this.parts.clear()
        viewer.scene.addObject(group as any)
        return group
    }
}
