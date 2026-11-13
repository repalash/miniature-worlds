/**
 * Seeded noise for runtime terrain and scatter: a small PRNG, 2D gradient noise, fbm, ridged fbm and domain warp.
 * Deterministic for a seed, so every load and every capture builds the same world.
 */

/** mulberry32: a fast 32-bit PRNG. Returns a function that yields floats in [0, 1). */
export function rng(seed: number) {
    let a = seed >>> 0
    return () => {
        a = a + 0x6D2B79F5 >>> 0
        let t = a
        t = Math.imul(t ^ t >>> 15, t | 1)
        t ^= t + Math.imul(t ^ t >>> 7, t | 61)
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}

export class Noise2 {
    private readonly perm = new Uint8Array(512)
    private readonly gx = new Float32Array(256)
    private readonly gy = new Float32Array(256)

    constructor(seed = 1) {
        const r = rng(seed)
        const p = new Uint8Array(256)
        for (let i = 0; i < 256; i++) p[i] = i
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(r() * (i + 1))
            const t = p[i]; p[i] = p[j]; p[j] = t
        }
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
        for (let i = 0; i < 256; i++) {
            const a = r() * Math.PI * 2
            this.gx[i] = Math.cos(a)
            this.gy[i] = Math.sin(a)
        }
    }

    /** Gradient noise in about [-0.7, 0.7]. */
    noise(x: number, y: number) {
        const xi = Math.floor(x), yi = Math.floor(y)
        const xf = x - xi, yf = y - yi
        const X = xi & 255, Y = yi & 255
        const p = this.perm
        const g = (h: number, dx: number, dy: number) => this.gx[h] * dx + this.gy[h] * dy
        const n00 = g(p[X + p[Y]], xf, yf)
        const n10 = g(p[X + 1 + p[Y]], xf - 1, yf)
        const n01 = g(p[X + p[Y + 1]], xf, yf - 1)
        const n11 = g(p[X + 1 + p[Y + 1]], xf - 1, yf - 1)
        const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
        const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
        const a = n00 + u * (n10 - n00)
        const b = n01 + u * (n11 - n01)
        return a + v * (b - a)
    }

    /** Fractal sum, normalized to about [-1, 1]. */
    fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5) {
        let sum = 0, amp = 1, norm = 0
        for (let i = 0; i < octaves; i++) {
            sum += this.noise(x, y) * amp
            norm += amp
            amp *= gain
            x = x * lacunarity + 17.3
            y = y * lacunarity - 9.1
        }
        return sum / norm * 1.6
    }

    /** Ridged fractal in [0, 1]: sharp crests, for eroded rock and dunes. */
    ridged(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5) {
        let sum = 0, amp = 0.5, norm = 0, prev = 1
        for (let i = 0; i < octaves; i++) {
            let n = 1 - Math.abs(this.noise(x, y) * 1.4)
            n *= n
            sum += n * amp * prev
            norm += amp
            prev = n
            amp *= gain
            x = x * lacunarity + 31.7
            y = y * lacunarity + 4.3
        }
        return sum / norm
    }

    /** fbm sampled at a position displaced by another fbm (domain warp): organic, less grid-like shapes. */
    warped(x: number, y: number, warp = 1, octaves = 5) {
        const wx = this.fbm(x + 5.2, y + 1.3, 3)
        const wy = this.fbm(x - 3.1, y + 7.7, 3)
        return this.fbm(x + warp * wx, y + warp * wy, octaves)
    }
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
export const smoothstep = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a))
    return t * t * (3 - 2 * t)
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
