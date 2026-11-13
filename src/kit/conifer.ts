import {
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Color,
    DoubleSide,
    InstancedMesh,
    Matrix4,
    mergeGeometries,
    PhysicalMaterial,
    Quaternion,
    SRGBColorSpace,
    ThreeViewer,
    Vector3,
} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {NOISE} from './proc'
import {fixGBufferAlphaTest} from './gbuffer'
import {Noise2, rng} from './noise'
import type {Placement} from './scatter'

/**
 * Procedural conifers (Norway spruce, silver fir, larch), instanced: a few template trees, each a tapered trunk,
 * whorls of branches as drooping sprays of needle cards (alpha tested, folded along the twig) and a dark core cone
 * inside the crown, so a crown reads as a dense volume from any side and its gaps show shade, not sky.
 *
 * Shading: the card normals are bent toward the crown's outside (from the trunk axis, read from the instance
 * matrix), so the sun lights one side of the cone and the other falls into shade; thin needles let a share of the
 * sun through; each instance gets its own tint. `snow` loads the up-facing sprays and the core's shoulders with snow.
 * One template costs about 2.5k triangles.
 */

export type ConiferKind = 'spruce' | 'fir' | 'larch'

export interface ConiferOptions {
    kind?: ConiferKind
    /** 0..1: snow on the branches. */
    snow?: number
    /** Trees standing below this height (their base, m) get no snow; full snow 2 m above it. */
    snowLine?: number
    /** Template height (m); placements scale it. */
    height?: number
    /** Number of template trees. */
    variants?: number
    seed?: number
    /** Needle colour multiplier (linear). */
    tint?: [number, number, number]
    name?: string
    /**
     * Far trees: each tier of branches as one jagged, drooping skirt (opaque, no cards), about 300 triangles a tree:
     * for the land round a tile, seen from 30 m and more.
     */
    lod?: boolean
}

/** Needle spray sprite: a twig with side twigs, covered in short needles; the tips lighter (new growth). */
function spraySprite(kind: ConiferKind, seed: number) {
    const W = 128, H = 256
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const x = c.getContext('2d')!
    const r = rng(seed)
    const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`
    const larch = kind === 'larch'
    const baseH = larch ? 44 : kind === 'fir' ? 135 : 150, baseS = larch ? 70 : 28
    const needles = (x0: number, y0: number, x1: number, y1: number, len: number, density: number, light: number) => {
        const n = Math.round(Math.hypot(x1 - x0, y1 - y0) * density)
        for (let i = 0; i < n; i++) {
            const k = i / n
            const px = x0 + (x1 - x0) * k, py = y0 + (y1 - y0) * k
            const ang = Math.atan2(y1 - y0, x1 - x0)
            for (const side of [-1, 1]) {
                const a = ang + side * (0.9 + 0.5 * r()) + (r() - 0.5) * 0.3
                const l = len * (0.7 + 0.5 * r()) * (larch ? 0.8 : 1)
                const tip = k > 0.75 ? 1 : 0
                x.strokeStyle = hsl(baseH + (r() - 0.5) * 16 + tip * (larch ? 4 : -25), baseS + tip * 15, (larch ? 40 : 13) + light + 8 * r() + tip * (larch ? 8 : 10))
                x.lineWidth = larch ? 1.0 : 1.3
                x.beginPath()
                x.moveTo(px, py)
                x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l)
                x.stroke()
            }
        }
    }
    // main twig up the card (v), side twigs alternating
    const cx = W / 2
    x.strokeStyle = '#3a2a1c'
    x.lineWidth = 3
    x.beginPath(); x.moveTo(cx, H - 2); x.lineTo(cx, 8); x.stroke()
    const side: [number, number, number, number][] = []
    for (let i = 0; i < 13; i++) {
        const y = H - 22 - i * 17 - r() * 5
        const s = i % 2 ? 1 : -1
        const len = (W * 0.44) * (1 - 0.55 * (i / 13)) * (0.8 + 0.3 * r())
        const a = -Math.PI / 2 + s * (0.85 + 0.2 * r())
        side.push([cx, y, cx + Math.cos(a) * len, y + Math.sin(a) * len])
    }
    for (const [x0, y0, x1, y1] of side) {
        x.strokeStyle = '#3d2c1e'; x.lineWidth = 1.6
        x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke()
        needles(x0, y0, x1, y1, 9, 0.75, 0)
        // second-order twigs off the outer half
        for (let k = 0; k < 2; k++) {
            const t = 0.45 + 0.3 * k + 0.1 * r()
            const sx = x0 + (x1 - x0) * t, sy = y0 + (y1 - y0) * t
            const a = Math.atan2(y1 - y0, x1 - x0) + (k ? 0.7 : -0.7)
            const l = 14 + 8 * r()
            needles(sx, sy, sx + Math.cos(a) * l, sy + Math.sin(a) * l, 7, 0.8, 2)
        }
    }
    needles(cx, H - 4, cx, 8, 13, 0.6, 4)
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    t.anisotropy = 4
    t.needsUpdate = true
    return t
}

/** A card folded along its long axis (a shallow V, ridge up), length along +x, width along z, 4 triangles. */
function foldedCard(len: number, wid: number, fold = 0.35) {
    const h = wid / 2, d = Math.sin(fold) * h
    const pos = [
        -len / 2, 0, 0, len / 2, 0, 0, -len / 2, -d, h, len / 2, -d, h, // right wing
        -len / 2, -d, -h, len / 2, -d, -h, // left wing
    ]
    const uv = [0, 0.5, 1, 0.5, 0, 1, 1, 1, 0, 0, 1, 0]
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
    // the sprite's twig runs along v: swap so the twig runs along the card's length
    const uvs = g.attributes.uv
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getY(i), uvs.getX(i))
    g.setIndex([0, 2, 1, 1, 2, 3, 4, 0, 5, 5, 0, 1])
    g.computeVertexNormals()
    return g
}

interface Template {foliage: BufferGeometry, core: BufferGeometry, trunk: BufferGeometry}

/** One tree, height H, in local space (trunk base at the origin). */
function template(kind: ConiferKind, H: number, seed: number): Template {
    const r = rng(seed)
    const noise = new Noise2(seed)
    const larch = kind === 'larch', fir = kind === 'fir'
    const y0 = H * (larch ? 0.25 : 0.08 + 0.06 * r())
    const Rmax = H * (larch ? 0.2 : fir ? 0.2 : 0.23) * (0.85 + 0.3 * r())
    const crownR = (y: number) => {
        const k = Math.max(0, (H - y) / (H - y0))
        // spruce: a straight cone; fir: rounder shoulders; larch: open and irregular
        const shape = fir ? Math.pow(k, 0.8) * (1 - 0.15 * k * k) : larch ? Math.pow(k, 0.85) : Math.pow(k, 0.95)
        return Rmax * shape * (0.9 + 0.2 * noise.noise(y * 0.7, 1.3))
    }
    const cards: BufferGeometry[] = []
    const q = new Quaternion(), m = new Matrix4(), s = new Vector3(1, 1, 1)
    const whorlStep = H * (larch ? 0.05 : 0.034)
    for (let y = y0; y < H * 0.97; y += whorlStep * (0.8 + 0.4 * r())) {
        const R = crownR(y)
        if (R < 0.05) continue
        const nb = (larch ? 4 : 5) + Math.floor(r() * 3)
        const a0 = r() * 6.28
        for (let b = 0; b < nb; b++) {
            const az = a0 + b / nb * 6.28 + (r() - 0.5) * 0.5
            const len = R * (0.85 + 0.3 * r())
            const dir = new Vector3(Math.cos(az), 0, Math.sin(az))
            // spruce branches droop and turn up at the tips; firs stand out flat; larch branches sag
            const droop = fir ? 0.05 : larch ? 0.3 : 0.28
            const nCards = Math.max(1, Math.round(len / (H * 0.042)))
            for (let k = 0; k < nCards; k++) {
                const t = (k + 0.6) / nCards
                const along = len * t
                const sag = -droop * len * (t - (larch ? 0.2 : 0.75) * t * t) - (fir ? 0 : 0.04 * H * t)
                const p = dir.clone().multiplyScalar(along).setY(y + sag)
                const cardLen = (len / nCards) * 1.6 + H * 0.015
                const cardW = cardLen * (0.55 + 0.2 * r())
                const g = foldedCard(cardLen, cardW, larch ? 0.5 : 0.3)
                // yaw along the branch, pitch with the droop, roll a little
                const pitch = -Math.atan(droop * (1 - 2 * (larch ? 0.2 : 0.75) * t)) + (r() - 0.5) * 0.3
                q.setFromAxisAngle(new Vector3(0, 1, 0), -az)
                q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch))
                q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (r() - 0.5) * 0.7))
                g.applyMatrix4(m.compose(p, q, s))
                cards.push(g)
                // a hanging side spray under the outer half (spruce "curtains"), fills the silhouette from the side
                if (!fir && t > 0.4 && r() < (larch ? 0.3 : 0.55)) {
                    const g2 = foldedCard(cardLen * 0.8, cardW * 0.8, 0.2)
                    q.setFromAxisAngle(new Vector3(0, 1, 0), -az)
                    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 + (r() - 0.5) * 0.6))
                    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -1.2))
                    g2.applyMatrix4(m.compose(p.clone().add(new Vector3(0, -cardLen * 0.25, 0)), q, s))
                    cards.push(g2)
                }
            }
        }
    }
    // the leader: crossed vertical sprays at the top
    for (let i = 0; i < 3; i++) {
        const g = foldedCard(H * 0.09, H * 0.045, 0.2)
        q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
        q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), i * 2.1))
        g.applyMatrix4(m.compose(new Vector3(0, H * 0.955, 0), q, s))
        cards.push(g)
    }
    const foliage = mergeGeometries(cards, false)!
    cards.forEach(c => c.dispose())

    // core: a lumpy cone inside the crown (the shade between the branches)
    const rings = 14, seg = 10
    const cp: number[] = [], ci: number[] = []
    for (let i = 0; i <= rings; i++) {
        const y = y0 + (H * 0.95 - y0) * i / rings
        const R = crownR(y) * (larch ? 0.35 : 0.62) * (i === rings ? 0 : 1)
        for (let j = 0; j < seg; j++) {
            const a = j / seg * 6.28
            const rr = R * (0.8 + 0.35 * noise.noise(Math.cos(a) * 2 + y, Math.sin(a) * 2))
            cp.push(Math.cos(a) * rr, y - (larch ? 0 : 0.06 * H * (1 - i / rings) * 0.5), Math.sin(a) * rr)
        }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
        const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, d = b + seg
        ci.push(a, c, b, b, c, d)
    }
    const core = new BufferGeometry()
    core.setAttribute('position', new BufferAttribute(new Float32Array(cp), 3))
    core.setIndex(ci)
    core.computeVertexNormals()

    // trunk: tapered, a slight lean
    const tp: number[] = [], ti: number[] = []
    const tRings = 8, tSeg = 7
    for (let i = 0; i <= tRings; i++) {
        const k = i / tRings, y = H * k
        const rad = H * 0.022 * (1 - 0.92 * k) * (i === 0 ? 1.4 : 1)
        const ox = 0.01 * H * Math.sin(k * 3 + seed), oz = 0.01 * H * Math.cos(k * 2.3 + seed)
        for (let j = 0; j < tSeg; j++) {
            const a = j / tSeg * 6.28
            tp.push(ox + Math.cos(a) * rad, y - (i === 0 ? 0.3 : 0), oz + Math.sin(a) * rad)
        }
    }
    for (let i = 0; i < tRings; i++) for (let j = 0; j < tSeg; j++) {
        const a = i * tSeg + j, b = i * tSeg + (j + 1) % tSeg, c = a + tSeg, d = b + tSeg
        ti.push(a, c, b, b, c, d)
    }
    const trunk = new BufferGeometry()
    trunk.setAttribute('position', new BufferAttribute(new Float32Array(tp), 3))
    trunk.setIndex(ti)
    trunk.computeVertexNormals()
    return {foliage, core, trunk}
}

/** A far tree: tiers of jagged drooping skirts round a trunk, opaque. */
function lodTemplate(kind: ConiferKind, H: number, seed: number): Template {
    const r = rng(seed)
    const fir = kind === 'fir', larch = kind === 'larch'
    const y0 = H * (larch ? 0.25 : 0.1)
    const Rmax = H * (fir ? 0.2 : 0.23) * (0.85 + 0.3 * r())
    const tiers = 9
    const pos: number[] = [], idx: number[] = []
    const seg = 14
    for (let t = 0; t < tiers; t++) {
        const k0 = t / tiers, k1 = (t + 1.6) / tiers
        const yb = y0 + (H - y0) * k0, yt = Math.min(H, y0 + (H - y0) * k1)
        const R = Rmax * Math.pow(1 - k0, 0.95) * (0.9 + 0.2 * r())
        const base = pos.length / 3
        // ring at the top (narrow, at the trunk) and a jagged outer rim drooping below the tier's base
        pos.push(0, yt, 0)
        const a0 = r() * 6.28
        for (let j = 0; j < seg; j++) {
            const a = a0 + j / seg * 6.28
            const rr = R * (j % 2 ? 0.62 : 1) * (0.85 + 0.3 * r())
            pos.push(Math.cos(a) * rr, yb - (j % 2 ? 0 : 0.04 * H), Math.sin(a) * rr)
        }
        for (let j = 0; j < seg; j++) idx.push(base, base + 1 + (j + 1) % seg, base + 1 + j)
        // underside, a little higher in the middle
        const ub = pos.length / 3
        pos.push(0, yb + 0.25 * (yt - yb), 0)
        for (let j = 0; j < seg; j++) idx.push(ub, base + 1 + j, base + 1 + (j + 1) % seg)
    }
    const foliage = new BufferGeometry()
    foliage.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    foliage.setIndex(idx)
    const nonIndexed = foliage.toNonIndexed()
    nonIndexed.computeVertexNormals()
    const trunk = new BufferGeometry()
    const tp = [0, -0.3, 0.06 * H * 0.3, 0.05 * H * 0.3, -0.3, -0.04 * H * 0.3, -0.05 * H * 0.3, -0.3, -0.03 * H * 0.3, 0, H * 0.3, 0]
    trunk.setAttribute('position', new BufferAttribute(new Float32Array(tp), 3))
    trunk.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3])
    trunk.computeVertexNormals()
    return {foliage: nonIndexed, core: new BufferGeometry(), trunk}
}

const VERT = /* glsl */`
varying vec3 vCnPos;
varying vec3 vCnCrown;
varying float vCnSeed;
varying float vCnBaseY;
`

const FRAG = /* glsl */`
varying vec3 vCnPos;
varying vec3 vCnCrown;
varying float vCnSeed;
uniform float cnSnow;
uniform float cnSnowLine;
varying float vCnBaseY;
uniform vec3 cnTint;
${NOISE}
float cnSnowK;
`

/** Material extension shared by the needles and the core: crown normals, instance tint, snow, sun through needles. */
function coniferExtension(part: 'needles' | 'core' | 'bark', snow: { value: number }, tint: {value: Color}, snowLine: {value: number}): MaterialExtension {
    const key = 'conifer-' + part
    return {
        extraUniforms: {cnSnow: snow, cnTint: tint, cnSnowLine: snowLine} as any,
        parsVertexSnippet: VERT,
        parsFragmentSnippet: FRAG,
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    {
        vec4 cw = vec4(transformed, 1.0);
        vec3 base = vec3(0.0);
        float scale = 1.0;
        #ifdef USE_INSTANCING
        cw = instanceMatrix * cw;
        base = instanceMatrix[3].xyz;
        scale = length(instanceMatrix[1].xyz);
        #endif
        cw = modelMatrix * cw;
        base = (modelMatrix * vec4(base, 1.0)).xyz;
        vCnPos = cw.xyz;
        // the crown normal of a cone: out from the axis and up
        vec3 rad = vec3(cw.x - base.x, 0.0, cw.z - base.z);
        vCnCrown = normalize(normalize(rad + 1e-4) + vec3(0.0, 0.55, 0.0));
        vCnSeed = fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453);
        vCnBaseY = base.y;
    }
`)
            let fs = shader.fragmentShader
            fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
    {
        // each tree its own shade: darker and bluer, or yellower
        vec3 tintI = mix(vec3(0.82, 0.9, 0.95), vec3(1.12, 1.08, 0.86), vCnSeed);
        ${part === 'bark' ? 'diffuseColor.rgb *= 0.85 + 0.3 * vCnSeed;' : 'diffuseColor.rgb *= cnTint * tintI;'}
        ${part === 'core' ? 'diffuseColor.rgb *= 0.55 + 0.35 * n_snoise3(vCnPos * 3.0);' : ''}
        // snow on the up-facing sprays (front face seen from above) and on the core's shoulders
        vec3 wn = normalize(cross(dFdx(vCnPos), dFdy(vCnPos)));
        wn *= sign(dot(wn, cameraPosition - vCnPos));
        float up = ${part === 'core' ? 'max(vCnCrown.y * 0.9, wn.y)' : 'wn.y'};
        float lumpy = n_snoise3(vCnPos * 2.2) * 0.5 + n_snoise3(vCnPos * 9.0) * 0.25;
        cnSnowK = cnSnow * smoothstep(cnSnowLine, cnSnowLine + 2.0, vCnBaseY) * smoothstep(0.35, 0.75, up + lumpy * 0.35 + (cnSnow - 0.5) * 0.4) ${part === 'bark' ? '* 0.0' : ''};
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), cnSnowK);
    }
`)
            if (part !== 'bark') {
                fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    {
        vec3 crown = normalize((viewMatrix * vec4(vCnCrown, 0.0)).xyz);
        normal = normalize(mix(normal, crown, ${part === 'core' ? '0.75' : '0.6'}));
    }
`)
                fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = mix(roughnessFactor, 0.7, cnSnowK);
`)
                // needles let the sun through: a share of it on the shaded side, a forward lobe toward the sun
                fs = fs.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
    #if NUM_DIR_LIGHTS > 0
    {
        vec3 L = directLight.direction;
        float fwd = pow(saturate(dot(-geometryViewDir, L)), 5.0);
        float back = saturate(-dot(geometryNormal, L));
        vec3 T = diffuseColor.rgb * (0.4 + 1.8 * diffuseColor.rgb) * (1.0 - cnSnowK);
        reflectedLight.directDiffuse += directLight.color * T * (${part === 'core' ? '0.1' : '0.35'} * back + ${part === 'core' ? '0.2' : '1.0'} * fwd);
    }
    #endif
`)
            }
            shader.fragmentShader = fs
        },
        computeCacheKey: () => key,
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
}

export interface ConiferSet {
    meshes: InstancedMesh[]
    triangles: number
    materials: {needles: PhysicalMaterial, core: PhysicalMaterial, bark: PhysicalMaterial}
    uniforms: {snow: {value: number}, tint: {value: Color}, snowLine: {value: number}}
}

/** Builds the template trees and instances them at the placements (scale 1 = the template height). */
export function buildConifers(viewer: ThreeViewer, placements: Placement[], o: ConiferOptions = {}): ConiferSet {
    const kind = o.kind ?? 'spruce'
    const H = o.height ?? 10
    const nv = o.variants ?? 4
    const seed = o.seed ?? 1
    const name = o.name ?? 'Conifers'
    fixGBufferAlphaTest(viewer)
    const snow = {value: o.snow ?? 0}
    const tint = {value: new Color(...(o.tint ?? [1, 1, 1]))}
    const snowLine = {value: o.snowLine ?? -1e4}
    const needles = new PhysicalMaterial({color: '#ffffff', roughness: 0.85, metalness: 0})
    needles.name = name + ' needles'
    needles.map = spraySprite(kind, seed * 7 + 1)
    needles.alphaTest = 0.5
    needles.side = DoubleSide
    needles.registerMaterialExtensions([coniferExtension('needles', snow, tint, snowLine)])
    const coreCol = kind === 'larch' ? new Color(0.16, 0.11, 0.035) : new Color(0.018, 0.04, 0.03)
    const core = new PhysicalMaterial({color: coreCol, roughness: 0.95, metalness: 0})
    core.name = name + ' core'
    core.registerMaterialExtensions([coniferExtension('core', snow, tint, snowLine)])
    const bark = new PhysicalMaterial({color: new Color(0.12, 0.085, 0.06), roughness: 0.95, metalness: 0})
    bark.name = name + ' bark'
    bark.registerMaterialExtensions([coniferExtension('bark', snow, tint, snowLine)])
    // far trees: the tiers in a mid green (they stand for needles and the shade between them at once)
    let lodMat: PhysicalMaterial | undefined
    if (o.lod) {
        lodMat = new PhysicalMaterial({color: kind === 'larch' ? new Color(0.3, 0.2, 0.05) : new Color(0.03, 0.065, 0.045), roughness: 0.92, metalness: 0})
        lodMat.name = name + ' tiers'
        lodMat.registerMaterialExtensions([coniferExtension('core', snow, tint, snowLine)])
    }
    const r = rng(seed * 31 + 5)
    const groups: Placement[][] = Array.from({length: nv}, () => [])
    for (const p of placements) groups[Math.floor(r() * nv)].push(p)
    const meshes: InstancedMesh[] = []
    let triangles = 0
    const _m = new Matrix4(), _q = new Quaternion(), _s = new Vector3()
    for (let v = 0; v < nv; v++) {
        if (!groups[v].length) continue
        const t = o.lod ? lodTemplate(kind, H, seed * 100 + v) : template(kind, H, seed * 100 + v)
        const parts = o.lod ? [[t.trunk, bark, 'trunk'], [t.foliage, lodMat!, 'tiers']] as const : [[t.trunk, bark, 'trunk'], [t.core, core, 'core'], [t.foliage, needles, 'needles']] as const
        for (const [geo, mat, label] of parts) {
            const im = new InstancedMesh(geo, mat, groups[v].length)
            im.name = `${name} ${v}: ${label}`
            groups[v].forEach((p, i) => {
                _q.setFromAxisAngle(new Vector3(0, 1, 0), p.rotationY ?? 0)
                if (typeof p.scale === 'number' || p.scale === undefined) _s.setScalar(p.scale ?? 1)
                else _s.copy(p.scale)
                im.setMatrixAt(i, _m.compose(p.position, _q, _s))
            })
            im.instanceMatrix.needsUpdate = true
            im.castShadow = true
            im.receiveShadow = true
            im.computeBoundingSphere()
            viewer.scene.addObject(im as any)
            meshes.push(im)
            triangles += ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) * groups[v].length
        }
    }
    return {meshes, triangles, materials: {needles, core, bark}, uniforms: {snow, tint, snowLine}}
}
