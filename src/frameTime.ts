import {ThreeViewer, Vector3} from 'threepipe'

/** Turns the camera around its target by `angle` radians (keeps frames moving, so every frame renders). */
export function orbitStep(viewer: ThreeViewer, angle: number) {
    const cam = viewer.scene.mainCamera
    const t = cam.target
    const p = cam.position.clone().sub(t)
    p.applyAxisAngle(new Vector3(0, 1, 0), angle)
    cam.position.copy(t).add(p)
    cam.lookAt(t)
    cam.setDirty()
}

export interface FrameTimeReport {
    /** GPU (or CPU-synced) time of one frame, ms. */
    medianMs: number
    p90Ms: number
    frames: number
    /** 'gpu-timer-query' (EXT_disjoint_timer_query_webgl2) or 'cpu-sync' (an upper bound, includes CPU work). */
    timer: string
    size: [number, number]
    gpu: string
}

/**
 * Measures the frame time of the current view on moving frames: the camera turns a little every frame, so the
 * progressive and temporal plugins never settle and each frame does its full work (what a user sees while orbiting).
 * Uses the WebGL2 GPU timer when the browser exposes it; otherwise a 1-pixel readPixels after each render syncs the
 * GPU and the CPU time from the start of the render is used. The camera is put back afterwards.
 */
export async function measureFrameTime(viewer: ThreeViewer, o: {frames?: number, warmup?: number, angle?: number} = {}): Promise<FrameTimeReport> {
    const frames = o.frames ?? 120, warmup = o.warmup ?? 30, angle = o.angle ?? 0.004
    const gl = viewer.renderManager.webglRenderer.getContext() as WebGL2RenderingContext
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    const cam = viewer.scene.mainCamera
    const start = cam.position.clone()
    const ms: number[] = []
    const pending: WebGLQuery[] = []
    let f = 0, active: WebGLQuery | null = null, cpuStart = 0
    const poll = () => {
        while (pending.length) {
            const q = pending[0]
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
            pending.shift()
            const disjoint = ext && gl.getParameter(ext.GPU_DISJOINT_EXT)
            const t = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
            gl.deleteQuery(q)
            if (!disjoint) ms.push(t)
        }
    }
    const pre = () => {
        if (f < warmup) return
        if (ext) {
            active = gl.createQuery()!
            gl.beginQuery(ext.TIME_ELAPSED_EXT, active)
        } else cpuStart = performance.now()
    }
    const post = () => {
        if (f < warmup) return
        if (ext) {
            if (!active) return
            gl.endQuery(ext.TIME_ELAPSED_EXT)
            pending.push(active)
            active = null
        } else {
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
            ms.push(performance.now() - cpuStart)
        }
    }
    viewer.addEventListener('preRender', pre)
    viewer.addEventListener('postRender', post)
    await new Promise<void>(resolve => {
        const frame = () => {
            orbitStep(viewer, angle)
            poll()
            if (++f >= warmup + frames) {
                viewer.removeEventListener('preFrame', frame)
                resolve()
            }
        }
        viewer.addEventListener('preFrame', frame)
    })
    viewer.removeEventListener('preRender', pre)
    viewer.removeEventListener('postRender', post)
    for (let i = 0; i < 20 && pending.length; i++) {
        await new Promise(r => setTimeout(r, 50))
        poll()
    }
    cam.position.copy(start)
    cam.lookAt(cam.target)
    cam.setDirty()
    const s = [...ms].sort((a, b) => a - b)
    const q = (x: number) => s.length ? +s[Math.min(s.length - 1, Math.floor(x * s.length))].toFixed(2) : NaN
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
        medianMs: q(0.5), p90Ms: q(0.9), frames: s.length,
        timer: ext ? 'gpu-timer-query' : 'cpu-sync',
        size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        gpu: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    }
}
