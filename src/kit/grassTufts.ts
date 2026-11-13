import {BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, PhysicalMaterial, Quaternion, ThreeViewer, Vector3} from 'threepipe'
import {procExtension} from './proc'
import {rng} from './noise'

/**
 * Grass as geometry, not cards: a tuft is a bunch of tapered, curved blades (and optional seed heads), with a
 * colour ramp from the base to the tip in its vertex colours; tufts are instanced over a terrain by a density
 * rule on a jittered grid, each with its own height, lean and colour. No alpha test, so the G-buffer (and SSGI)
 * sees exactly the blades. The shading bends the normal up (a sward reads as a soft volume, not as glinting
 * strips) and lets the sun through the blades: seen against a low sun they glow.
 */

export interface TuftSpec {
    blades: number
    /** Blade height (m) and its spread (fraction). */
    height: number
    spread?: number
    /** Blade width at the base (m). */
    width: number
    /** How far the blades curve outward (0 straight). */
    bend?: number
    /** Radius of the tuft's base (m). */
    radius?: number
    /** Segments along a blade. */
    segments?: number
    /** Colours (linear): base, middle, tip. */
    base: [number, number, number]
    mid: [number, number, number]
    tip: [number, number, number]
    /** Seed heads: count per tuft, colour, length. */
    heads?: number
    headColor?: [number, number, number]
    headLength?: number
    /** 'droop': a nodding raceme of spikelets (grasses, rice); 'spike': an upright cylinder (cattail, bulrush). */
    headStyle?: 'droop' | 'spike'
    /** Width of the bare stem under a head (default 0.18 of the blade width). */
    stemWidth?: number
    headWidth?: number
    seed?: number
}

/** One tuft as a geometry (origin at the base centre). */
export function tuftGeometry(t: TuftSpec) {
    const r = rng(t.seed ?? 1)
    const seg = t.segments ?? 4
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = []
    const cBase = new Color(...t.base), cMid = new Color(...t.mid), cTip = new Color(...t.tip)
    const c = new Color()
    const blade = (h: number, w: number, ang: number, lean: number, ox: number, oz: number, ramp: (k: number, out: Color) => Color, twist: number) => {
        const start = pos.length / 3
        const dx = Math.cos(ang), dz = Math.sin(ang)
        // side direction across the blade
        const sx = -dz, sz = dx
        for (let i = 0; i <= seg; i++) {
            const k = i / seg
            // curved: out along the lean, quadratically
            const out = lean * h * k * k
            const y = h * k * (1 - 0.25 * lean * k)
            const half = 0.5 * w * (1 - k * 0.92) * (i === seg ? 0 : 1)
            const tw = twist * k
            const ax = sx * Math.cos(tw) + dx * Math.sin(tw), az = sz * Math.cos(tw) + dz * Math.sin(tw)
            const cx = ox + dx * out, cz = oz + dz * out
            ramp(k, c)
            for (const s of [-1, 1]) {
                pos.push(cx + ax * half * s, y, cz + az * half * s)
                // normal: across the blade face, tilted up; the shader bends it further
                const nx = dz * 0.7 + 0, nz = -dx * 0.7
                nor.push(nx, 0.7, nz)
                col.push(c.r, c.g, c.b)
            }
        }
        for (let i = 0; i < seg; i++) {
            const a = start + i * 2
            idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
        }
    }
    const R = t.radius ?? 0.05
    for (let b = 0; b < t.blades; b++) {
        const ang = r() * Math.PI * 2
        const rr = R * Math.sqrt(r())
        const h = t.height * (1 - (t.spread ?? 0.35) * r())
        const lean = (t.bend ?? 0.35) * (0.4 + 0.9 * r())
        const shade = 0.8 + 0.4 * r()
        blade(h, t.width * (0.7 + 0.6 * r()), ang, lean, Math.cos(ang) * rr, Math.sin(ang) * rr, (k, out) => {
            if (k < 0.5) out.copy(cBase).lerp(cMid, k * 2)
            else out.copy(cMid).lerp(cTip, (k - 0.5) * 2)
            return out.multiplyScalar(shade)
        }, (r() - 0.5) * 1.4)
    }
    // seed heads: a bare stem above the leaves, the tip a dense spikelet (wider strip)
    const nh = t.heads ?? 0
    const hc = new Color(...(t.headColor ?? t.tip))
    for (let s = 0; s < nh; s++) {
        const ang = r() * Math.PI * 2
        const h = t.height * (1.25 + 0.35 * r())
        const L = t.headLength ?? 0.12
        const lean = 0.12 + 0.2 * r()
        blade(h - L, t.stemWidth ?? t.width * 0.18, ang, lean, 0, 0, (k, out) => out.copy(cMid).lerp(hc, k), 0)
        if (t.headStyle === 'spike') {
            // an upright spike: two crossed strips round the stem's tip (a cattail's brown head)
            const out2 = lean * (h - L)
            const ox2 = Math.cos(ang) * out2, oz2 = Math.sin(ang) * out2
            const y0 = (h - L) * (1 - 0.25 * lean), hw = (t.headWidth ?? 0.03) / 2
            for (const rot of [0, Math.PI / 2]) {
                const ca = Math.cos(ang + rot) * hw, sa = Math.sin(ang + rot) * hw
                const st = pos.length / 3
                for (let i = 0; i <= 3; i++) {
                    const k = i / 3
                    const w2 = i === 0 || i === 3 ? 0.55 : 1
                    for (const sgn of [-1, 1]) {
                        pos.push(ox2 + ca * sgn * w2, y0 + L * k, oz2 + sa * sgn * w2)
                        nor.push(-sa * sgn, 0.3, ca * sgn)
                        c.copy(hc).multiplyScalar(0.85 + 0.25 * Math.sin(k * 3.1))
                        col.push(c.r, c.g, c.b)
                    }
                }
                for (let i = 0; i < 3; i++) { const a2 = st + i * 2; idx.push(a2, a2 + 1, a2 + 2, a2 + 2, a2 + 1, a2 + 3) }
            }
            continue
        }
        // the head: three or four spikelets drooping from the stem tip, each a narrow pointed strip
        const out = lean * (h - L)
        const ox = Math.cos(ang) * out, oz = Math.sin(ang) * out
        const top0 = (h - L) * (1 - 0.25 * lean)
        // a one-sided nodding raceme: the spikelets hang to the side the stem leans, one under the other
        const nsp = 3 + Math.floor(r() * 2)
        for (let k = 0; k < nsp; k++) {
            const da = ang + (r() - 0.5) * 0.5
            const droop = 0.9 + 0.5 * r()
            const dx = Math.cos(da) * Math.cos(droop), dz = Math.sin(da) * Math.cos(droop), dy = -Math.sin(droop)
            const len = L * (0.6 + 0.4 * r())
            const top = top0 - k * L * 0.18
            const start = pos.length / 3
            for (let i = 0; i <= 2; i++) {
                const kk = i / 2
                const half = t.width * 0.22 * (i === 2 ? 0.05 : i === 1 ? 1 : 0.6)
                const cx = ox + dx * len * kk, cy = top + dy * len * kk, cz = oz + dz * len * kk
                for (const sgn of [-1, 1]) {
                    pos.push(cx - dz * half * sgn, cy, cz + dx * half * sgn)
                    nor.push(0, 1, 0)
                    c.copy(hc).multiplyScalar(0.8 + 0.35 * kk)
                    col.push(c.r, c.g, c.b)
                }
            }
            for (let i = 0; i < 2; i++) {
                const a2 = start + i * 2
                idx.push(a2, a2 + 1, a2 + 2, a2 + 2, a2 + 1, a2 + 3)
            }
        }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
    g.setIndex(idx)
    g.computeBoundingSphere()
    return g
}

/**
 * The blade material: vertex colours, two-sided, normal bent up, and transmitted sun (a forward lobe toward the
 * sun and a share on the shaded side). `translucency` scales the transmitted light.
 */
export function grassMaterial(name = 'Grass', o: {roughness?: number, translucency?: number, up?: number} = {}) {
    const m = new PhysicalMaterial({color: '#ffffff', roughness: o.roughness ?? 0.85, metalness: 0})
    m.name = name
    m.vertexColors = true
    m.side = DoubleSide
    const tr = (o.translucency ?? 1).toFixed(3)
    const up = (o.up ?? 0.8).toFixed(3)
    m.registerMaterialExtensions([procExtension({
        key: 'grass-tuft',
        normal: /* glsl */`
    vec3 gUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    normal = normalize(normal * (1.0 - ${up}) + gUp * ${up});
`,
        light: /* glsl */`
    #if NUM_DIR_LIGHTS > 0
    vec3 gL = directLight.direction;
    float gFwd = pow(saturate(dot(-geometryViewDir, gL)), 8.0);
    float gBack = 0.5 + 0.5 * saturate(-dot(geometryNormal, gL));
    vec3 gT = diffuseColor.rgb * (0.4 + 2.0 * diffuseColor.rgb);
    reflectedLight.directDiffuse += directLight.color * gT * (0.35 * gBack + 1.8 * gFwd) * ${tr};
    #endif
`,
    })])
    return m
}

export interface TuftScatter {
    /** Area [x0, z0, x1, z1] and grid cell (m): one candidate per cell, jittered. */
    area: [number, number, number, number]
    cell: number
    /** Probability to keep a candidate (0..1) and a height scale at the place. */
    density: (x: number, z: number) => number
    scale?: (x: number, z: number) => number
    height: (x: number, z: number) => number
    /** Sink (m) and tilt toward the ground normal (0..1). */
    sink?: number
    seed?: number
    /** Colour variation per tuft: a multiplier (linear rgb) at the place. */
    tint?: (x: number, z: number, r: number) => [number, number, number]
    /** Maximum lean of a tuft (radians). */
    lean?: number
    max?: number
}

/** Matrices and colours for a tuft scatter. */
export function scatterTufts(s: TuftScatter) {
    const r = rng(s.seed ?? 7)
    const [x0, z0, x1, z1] = s.area
    const ms: Matrix4[] = [], cs: Color[] = []
    const q = new Quaternion(), e = new Vector3(), sc = new Vector3(), p = new Vector3(), ax = new Vector3()
    for (let z = z0; z < z1; z += s.cell) for (let x = x0; x < x1; x += s.cell) {
        const px = x + r() * s.cell, pz = z + r() * s.cell
        const keep = r()
        const rot = r(), rs = r(), rl = r(), ra = r(), rc = r()
        if (keep > s.density(px, pz)) continue
        const k = (s.scale ? s.scale(px, pz) : 1) * (0.75 + 0.5 * rs)
        if (k <= 0.05) continue
        p.set(px, s.height(px, pz) - (s.sink ?? 0.02), pz)
        ax.set(Math.cos(ra * 6.28), 0, Math.sin(ra * 6.28))
        const lean = (s.lean ?? 0.18) * rl
        q.setFromAxisAngle(e.set(0, 1, 0), rot * Math.PI * 2)
        q.premultiply(new Quaternion().setFromAxisAngle(ax, lean))
        sc.set(k * (0.85 + 0.3 * rc), k, k * (0.85 + 0.3 * rc))
        ms.push(new Matrix4().compose(p, q, sc))
        const t = s.tint ? s.tint(px, pz, rc) : [1, 1, 1]
        cs.push(new Color(t[0], t[1], t[2]))
        if (s.max && ms.length >= s.max) return {matrices: ms, colors: cs}
    }
    return {matrices: ms, colors: cs}
}

/** An InstancedMesh of a tuft geometry. */
export function tuftMesh(viewer: ThreeViewer, name: string, geometry: BufferGeometry, material: PhysicalMaterial,
    set: {matrices: Matrix4[], colors: Color[]}, o: {castShadow?: boolean} = {}) {
    const im = new InstancedMesh(geometry, material, Math.max(1, set.matrices.length))
    im.name = name
    // ground cover: a style preset that rebuilds the ground hides it
    im.userData.groundCover = true
    set.matrices.forEach((m, i) => im.setMatrixAt(i, m))
    set.colors.forEach((c, i) => im.setColorAt(i, c))
    im.count = set.matrices.length
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
    im.computeBoundingBox?.()
    viewer.scene.addObject(im as any)
    im.castShadow = o.castShadow ?? true
    im.receiveShadow = true
    return im
}
