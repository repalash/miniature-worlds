import {Vector3} from 'threepipe'

/**
 * A ground path (road, track, creek) through control points (x, y, z), smoothed with a centripetal Catmull-Rom
 * spline and sampled densely; nearest-point queries return the distance across, the distance along, the path's
 * height there and its direction. A coarse grid of the samples keeps the queries fast enough for per-vertex use.
 */
export class GroundPath {
    readonly pts: Vector3[] = []
    /** Distance along the path at each sample. */
    readonly s: number[] = []
    readonly length: number
    private readonly grid = new Map<number, number[]>()
    private readonly cell: number

    constructor(control: [number, number, number][], spacing = 0.25, cell = 4) {
        const c = control.map(p => new Vector3(...p))
        const P = [c[0].clone().multiplyScalar(2).sub(c[1]), ...c, c[c.length - 1].clone().multiplyScalar(2).sub(c[c.length - 2])]
        for (let i = 1; i < P.length - 2; i++) {
            const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2]
            const n = Math.max(2, Math.ceil(p1.distanceTo(p2) / spacing))
            for (let k = 0; k < n; k++) this.pts.push(catmull(p0, p1, p2, p3, k / n))
        }
        this.pts.push(c[c.length - 1].clone())
        let L = 0
        this.s.push(0)
        for (let i = 1; i < this.pts.length; i++) {
            L += Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].z - this.pts[i - 1].z)
            this.s.push(L)
        }
        this.length = L
        this.cell = cell
        this.pts.forEach((p, i) => {
            const k = this.key(p.x, p.z)
            let l = this.grid.get(k)
            if (!l) this.grid.set(k, l = [])
            l.push(i)
        })
    }

    private key(x: number, z: number) {
        return Math.floor(x / this.cell) * 7919 + Math.floor(z / this.cell)
    }

    /**
     * Nearest sample to (x, z) within `range` (m): distance across (unsigned), along, the path height, its index and
     * the side (+1 left of the direction of travel, -1 right). `d` is Infinity beyond the range.
     */
    nearest(x: number, z: number, range = 12) {
        let best = Infinity, bi = -1
        const r = Math.ceil(range / this.cell)
        const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell)
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
            const l = this.grid.get((cx + i) * 7919 + cz + j)
            if (!l) continue
            for (const k of l) {
                const p = this.pts[k]
                const d = (p.x - x) ** 2 + (p.z - z) ** 2
                if (d < best) { best = d; bi = k }
            }
        }
        if (bi < 0) return {d: Infinity, s: 0, y: 0, i: -1, side: 0}
        // refine on the segment toward the nearer neighbour
        const a = this.pts[bi], b = this.pts[Math.min(this.pts.length - 1, bi + 1)], b0 = this.pts[Math.max(0, bi - 1)]
        let seg = [a, b], s0 = this.s[bi], len = this.s[Math.min(this.pts.length - 1, bi + 1)] - s0
        const tOn = (p: Vector3, q: Vector3) => {
            const dx = q.x - p.x, dz = q.z - p.z, l2 = dx * dx + dz * dz
            return l2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / l2)) : 0
        }
        let t = tOn(a, b)
        if (t <= 0 && bi > 0) {
            seg = [b0, a]
            s0 = this.s[bi - 1]
            len = this.s[bi] - s0
            t = tOn(b0, a)
        }
        const [p, q] = seg
        const px = p.x + (q.x - p.x) * t, pz = p.z + (q.z - p.z) * t
        const d = Math.hypot(x - px, z - pz)
        const dx = q.x - p.x, dz = q.z - p.z
        const side = Math.sign(dx * (z - pz) - dz * (x - px)) || 1
        return {d, s: s0 + len * t, y: p.y + (q.y - p.y) * t, i: bi, side}
    }

    /** Point and direction (unit, xz) at distance `s` along. */
    at(s: number) {
        s = Math.max(0, Math.min(this.length, s))
        let lo = 0, hi = this.s.length - 1
        while (hi - lo > 1) {
            const m = (lo + hi) >> 1
            if (this.s[m] <= s) lo = m
            else hi = m
        }
        const a = this.pts[lo], b = this.pts[hi]
        const t = (s - this.s[lo]) / Math.max(1e-6, this.s[hi] - this.s[lo])
        const p = a.clone().lerp(b, t)
        const dir = new Vector3(b.x - a.x, 0, b.z - a.z).normalize()
        return {p, dir}
    }
}

function catmull(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number) {
    // centripetal parametrisation (alpha 0.5): no cusps or self-intersections at sharp hairpins
    const tj = (ti: number, a: Vector3, b: Vector3) => ti + Math.pow(Math.max(1e-6, a.distanceTo(b)), 0.5)
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3)
    const u = t1 + (t2 - t1) * t
    const A1 = p0.clone().multiplyScalar((t1 - u) / (t1 - t0)).add(p1.clone().multiplyScalar((u - t0) / (t1 - t0)))
    const A2 = p1.clone().multiplyScalar((t2 - u) / (t2 - t1)).add(p2.clone().multiplyScalar((u - t1) / (t2 - t1)))
    const A3 = p2.clone().multiplyScalar((t3 - u) / (t3 - t2)).add(p3.clone().multiplyScalar((u - t2) / (t3 - t2)))
    const B1 = A1.multiplyScalar((t2 - u) / (t2 - t0)).add(A2.clone().multiplyScalar((u - t0) / (t2 - t0)))
    const B2 = A2.multiplyScalar((t3 - u) / (t3 - t1)).add(A3.multiplyScalar((u - t1) / (t3 - t1)))
    return B1.multiplyScalar((t2 - u) / (t2 - t1)).add(B2.multiplyScalar((u - t1) / (t2 - t1)))
}
