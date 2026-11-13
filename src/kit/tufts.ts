import {
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Color,
    DoubleSide,
    InstancedMesh,
    Matrix4,
    PhysicalMaterial,
    Quaternion,
    SRGBColorSpace,
    ThreeViewer,
    Vector3,
} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {fixGBufferAlphaTest} from './gbuffer'
import {rng} from './noise'
import type {Placement} from './scatter'

/**
 * Grass tufts and small flowers as cheap instanced cards (three crossed quads, 6 triangles a tuft): a blade sprite
 * painted on a canvas at load time, from a base colour to a tip colour, with optional flower heads. The cards'
 * normals point up, so a meadow shades like the ground under it, and the tips let the sun through.
 */

export interface TuftStyle {
    /** sRGB css colours: blade base and tip, a dry share and a flower colour. */
    base: string
    tip: string
    dry?: string
    dryShare?: number
    flowers?: string[]
    flowerCount?: number
    blades?: number
    /** Card size: width and height in metres (scale 1). */
    width?: number
    height?: number
    seed?: number
}

function tuftSprite(st: TuftStyle) {
    const W = 256, H = 256
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const x = c.getContext('2d')!
    const r = rng(st.seed ?? 3)
    const blades = st.blades ?? 60
    const parse = (s: string) => new Color(s)
    const base = parse(st.base), tip = parse(st.tip), dry = parse(st.dry ?? st.tip)
    for (let i = 0; i < blades; i++) {
        const x0 = W * (0.15 + 0.7 * r()), h = H * (0.45 + 0.5 * r())
        const lean = (x0 - W / 2) * (0.6 + 0.8 * r()) + (r() - 0.5) * 60
        const w = 2.5 + 3 * r()
        const isDry = r() < (st.dryShare ?? 0.2)
        const g = x.createLinearGradient(0, H, 0, H - h)
        const b = base.clone(), t = (isDry ? dry : tip).clone()
        const k = 0.8 + 0.4 * r()
        g.addColorStop(0, `rgb(${b.r * 255 * k * 0.7},${b.g * 255 * k * 0.7},${b.b * 255 * k * 0.7})`)
        g.addColorStop(1, `rgb(${t.r * 255 * k},${t.g * 255 * k},${t.b * 255 * k})`)
        x.fillStyle = g
        x.beginPath()
        x.moveTo(x0 - w, H)
        x.quadraticCurveTo(x0 - w * 0.5 + lean * 0.3, H - h * 0.55, x0 + lean, H - h)
        x.quadraticCurveTo(x0 + w * 0.5 + lean * 0.3, H - h * 0.55, x0 + w, H)
        x.fill()
    }
    for (let i = 0; i < (st.flowerCount ?? 0); i++) {
        const fx = W * (0.2 + 0.6 * r()), fy = H * (0.15 + 0.4 * r())
        x.strokeStyle = st.base
        x.lineWidth = 1.5
        x.beginPath(); x.moveTo(fx, fy); x.lineTo(fx + (r() - 0.5) * 20, H); x.stroke()
        const col = st.flowers![Math.floor(r() * st.flowers!.length)]
        x.fillStyle = col
        for (let p = 0; p < 5; p++) {
            x.beginPath()
            x.arc(fx + Math.cos(p * 1.256) * 4, fy + Math.sin(p * 1.256) * 4, 4, 0, 6.28)
            x.fill()
        }
        x.fillStyle = '#f2d24a'
        x.beginPath(); x.arc(fx, fy, 2, 0, 6.28); x.fill()
    }
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    t.anisotropy = 4
    t.needsUpdate = true
    return t
}

function tuftGeometry(w: number, h: number) {
    const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = []
    for (let k = 0; k < 3; k++) {
        const a = k * Math.PI / 3
        const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2
        const b = pos.length / 3
        pos.push(-dx, 0, -dz, dx, 0, dz, -dx * 1.2, h, -dz * 1.2, dx * 1.2, h, dz * 1.2)
        uv.push(0, 0, 1, 0, 0, 1, 1, 1)
        for (let i = 0; i < 4; i++) nor.push(0, 1, 0)
        idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
    g.setIndex(idx)
    return g
}

const TUFT_EXT: MaterialExtension = {
    shaderExtender: (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
    #if NUM_DIR_LIGHTS > 0
    {
        float fwd = pow(saturate(dot(-geometryViewDir, directLight.direction)), 4.0);
        reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * (0.5 + 1.5 * diffuseColor.rgb) * (0.25 + 0.9 * fwd) * vMapUv.y;
    }
    #endif
`)
    },
    computeCacheKey: () => 'tuft-1',
    isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
}

/** Instanced tufts at the placements (scale 1 = the style's card size). */
export function buildTufts(viewer: ThreeViewer, placements: Placement[], st: TuftStyle, name = 'Grass tufts') {
    fixGBufferAlphaTest(viewer)
    const m = new PhysicalMaterial({color: '#ffffff', roughness: 0.85, metalness: 0})
    m.name = name
    m.map = tuftSprite(st)
    m.alphaTest = 0.5
    m.side = DoubleSide
    m.registerMaterialExtensions([TUFT_EXT])
    const im = new InstancedMesh(tuftGeometry(st.width ?? 0.5, st.height ?? 0.4), m, placements.length)
    im.name = name
    // ground cover: a style preset that rebuilds the ground hides it
    im.userData.groundCover = true
    const _m = new Matrix4(), _q = new Quaternion(), _s = new Vector3(), up = new Vector3(0, 1, 0)
    placements.forEach((p, i) => {
        _q.setFromAxisAngle(up, p.rotationY ?? 0)
        if (p.normal) _q.premultiply(new Quaternion().setFromUnitVectors(up, p.normal).slerp(new Quaternion(), 0.5))
        _s.setScalar(typeof p.scale === 'number' ? p.scale : 1)
        im.setMatrixAt(i, _m.compose(p.position, _q, _s))
    })
    im.instanceMatrix.needsUpdate = true
    im.castShadow = false
    im.receiveShadow = true
    im.computeBoundingSphere()
    viewer.scene.addObject(im as any)
    return {mesh: im, material: m, triangles: placements.length * 6}
}
