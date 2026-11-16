import {
    _testFinish,
    _testStart,
    GBufferPlugin,
    getUrlQueryParam,
    LoadingScreenPlugin,
    PCFSoftShadowMap,
    SSAAPlugin,
    SSAOPlugin,
    ThreeViewer,
    TonemapPlugin,
    UiObjectConfig,
    VignettePlugin,
} from 'threepipe'
import {TweakpaneUiPlugin} from '@threepipe/plugin-tweakpane'
import {BloomPlugin, DepthOfFieldPlugin, SSGIPlugin, SSReflectionPlugin, TemporalAAPlugin, VelocityBufferPlugin} from '@threepipe/webgi-plugins'
import {ColorGradePlugin} from './kit/grade'
import {fixGBufferAlphaTest} from './kit/gbuffer'
import {LightingRig} from './kit/lighting'
import {measureFrameTime, orbitStep} from './frameTime'
import {tiles} from './tiles'

// A miniature world viewer. URL parameters:
//   ?tile=<id>     the tile to open (ids in src/tiles/index.ts; the first is the default)
//   ?view=<name>   a named camera view of the tile
//   ?time=<name>   a named time of day of the tile
//   ?gi=0          start with SSGI off (compare with the split slider instead: left half without GI)
//   ?ui=0          no settings panel (clean frames for stills and videos)
//   ?scale=<x>     a fixed render scale instead of fitting the screen's pixel density
//   ?shadow=<px>   the sun's shadow map size (e.g. 512 for software rendering)
//   ?assets=<base> load remote files from a local mirror (src/kit/assets.ts)
// For scripts and agents: window.miniWorld = {viewer, ssgi, rig, state, result, measureFrameTime}, and the body gets
// the class `_testFinish` once the tile is built (scripts/shot.mjs waits for it).

const tileIds = Object.keys(tiles)
const tileId = tileIds.includes(getUrlQueryParam('tile') ?? '') ? getUrlQueryParam('tile')! : tileIds[0]

// Errors and a lost WebGL context show on the page, for phones without a console.
function showErrors(canvas: HTMLCanvasElement) {
    const box = document.createElement('pre')
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;margin:0;padding:6px;max-height:40%;overflow:auto;z-index:99;' +
        'font:11px monospace;white-space:pre-wrap;color:#fff;background:rgba(160,0,0,.85);display:none'
    document.body.appendChild(box)
    const lines: string[] = []
    const add = (s: string) => {
        if (lines.length >= 12 || lines.includes(s)) return
        lines.push(s.slice(0, 600))
        box.textContent = lines.join('\n')
        box.style.display = 'block'
    }
    const error = console.error.bind(console)
    console.error = (...a: any[]) => { error(...a); add(a.map(x => x instanceof Error ? x.message : String(x)).join(' ')) }
    window.addEventListener('error', e => add('Error: ' + e.message))
    window.addEventListener('unhandledrejection', e => add('Unhandled: ' + (e.reason?.message ?? e.reason)))
    canvas.addEventListener('webglcontextlost', () => add('WebGL context lost (GPU out of memory or a draw call ran too long)'))
}

async function init() {
    const canvas = document.getElementById('mcanvas') as HTMLCanvasElement
    showErrors(canvas)
    const viewer = new ThreeViewer({
        canvas,
        msaa: false,
        rgbm: true,
        maxHDRIntensity: 8,
        plugins: [LoadingScreenPlugin, GBufferPlugin, SSAAPlugin, SSAOPlugin, BloomPlugin, SSReflectionPlugin,
            TemporalAAPlugin, VelocityBufferPlugin, new SSGIPlugin(), new DepthOfFieldPlugin(false),
            new VignettePlugin(false), ColorGradePlugin],
    })
    // Render at the display's pixel density (up to 2x and about 4 MP), unless ?scale= sets it.
    const scale = Number(getUrlQueryParam('scale') ?? 0)
    const fit = () => {
        viewer.renderManager.renderScale = scale > 0 ? scale
            : Math.max(1, Math.min(devicePixelRatio, 2, Math.sqrt(4.2e6 / Math.max(1, innerWidth * innerHeight))))
    }
    fit()
    addEventListener('resize', fit)
    viewer.renderManager.renderer.shadowMap.type = PCFSoftShadowMap
    // The tile's look turns the grade on (src/kit/stage.ts).
    viewer.getPlugin(ColorGradePlugin)!.enabled = false
    const ssgi = viewer.getPlugin(SSGIPlugin)!
    // Alpha-tested leaf and grass cards cut out in the G-buffer too (src/kit/gbuffer.ts).
    fixGBufferAlphaTest(viewer)

    const rig = new LightingRig(viewer)
    const t0 = performance.now()
    const result = await tiles[tileId].setup({viewer, rig}) || {}
    console.log(`${tileId}: setup in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    if (getUrlQueryParam('gi') === '0') ssgi.enabled = false

    const {animate, camera: cameraPath} = result
    const views = result.views ?? {}
    const viewState = {view: getUrlQueryParam('view') ?? Object.keys(views)[0] ?? ''}
    if (views[viewState.view] && viewState.view !== Object.keys(views)[0]) views[viewState.view]()
    const times = result.times ?? {}
    const timeState = {time: getUrlQueryParam('time') ?? Object.keys(times)[0] ?? ''}
    if (times[timeState.time] && timeState.time !== Object.keys(times)[0]) await times[timeState.time]()

    // Animation, camera path and orbit run in real time (a slow frame moves further).
    const state = {orbit: false, cameraPath: false, animate: !!animate, speed: 0.3, split: 0, time: 0, cameraTime: 0}
    let last = performance.now()
    viewer.addEventListener('preFrame', () => {
        const now = performance.now()
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        if (state.animate && animate) {
            state.time += dt
            animate(state.time)
        }
        if (state.cameraPath && cameraPath) {
            state.cameraTime += dt
            cameraPath(state.cameraTime)
        } else if (state.orbit) orbitStep(viewer, state.speed * dt)
    })

    const measure = async(o?: Parameters<typeof measureFrameTime>[1]) => {
        const report = await measureFrameTime(viewer, o)
        console.log(`frame time ${tileId} / ${viewState.view}: median ${report.medianMs} ms, p90 ${report.p90Ms} ms ` +
            `(${report.frames} frames, ${report.size.join('x')}, ${report.gpu}, ${report.timer})`)
        return report
    }
    ;(window as any).miniWorld = {viewer, ssgi, rig, state, result, tileId, measureFrameTime: measure}

    const showPanel = getUrlQueryParam('ui') !== '0'
    if (showPanel) {
        const ui = viewer.addPluginSync(new TweakpaneUiPlugin(true))
        const selected = {id: tileId}
        const frameReport = {text: 'not measured'}
        const panel: UiObjectConfig = {
            type: 'folder',
            label: 'Tile',
            expanded: true,
            children: [
                {type: 'dropdown', label: 'Tile', property: [selected, 'id'], children: tileIds.map(id => ({label: tiles[id].label, value: id})),
                    onChange: () => {
                        if (selected.id === tileId) return
                        const u = new URL(location.href)
                        u.searchParams.set('tile', selected.id)
                        u.searchParams.delete('view')
                        u.searchParams.delete('time')
                        location.href = u.toString()
                    }},
                ...Object.keys(views).length ? [{type: 'dropdown', label: 'View', property: [viewState, 'view'],
                    children: Object.keys(views).map(v => ({label: v, value: v})),
                    onChange: () => {
                        state.cameraPath = false
                        state.orbit = false
                        views[viewState.view]?.()
                    }} as UiObjectConfig] : [],
                ...Object.keys(times).length ? [{type: 'dropdown', label: 'Time of day', property: [timeState, 'time'],
                    children: Object.keys(times).map(v => ({label: v, value: v})),
                    onChange: () => times[timeState.time]?.()} as UiObjectConfig] : [],
                ...cameraPath ? [{type: 'checkbox', label: 'Camera path', property: [state, 'cameraPath']} as UiObjectConfig] : [],
                {type: 'checkbox', label: 'Orbit camera', property: [state, 'orbit']},
                ...animate ? [{type: 'checkbox', label: 'Animate', property: [state, 'animate']} as UiObjectConfig] : [],
                {type: 'checkbox', label: 'SSGI', property: [ssgi, 'enabled'], onChange: () => viewer.setDirty()},
                {type: 'slider', label: 'Compare split (left: no GI)', bounds: [0, 1], stepSize: 0.01, property: [state, 'split'],
                    onChange: () => {
                        if (ssgi.pass) ssgi.pass.split = state.split
                        viewer.setDirty()
                    }},
                {type: 'button', label: 'Measure frame time', value: async() => {
                    frameReport.text = 'measuring...'
                    panel.uiRefresh?.(true)
                    const r = await measure()
                    frameReport.text = `${r.medianMs} ms median, ${r.p90Ms} ms p90 at ${r.size.join('x')}`
                    panel.uiRefresh?.(true)
                }},
                {type: 'input', label: 'Frame time', property: [frameReport, 'text'], readOnly: true},
            ],
        }
        ui.appendChild(panel)
        ui.appendChild(rig.uiConfig())
        ui.setupPluginUi(SSGIPlugin)
        ui.setupPluginUi(SSReflectionPlugin)
        ui.setupPluginUi(TemporalAAPlugin)
        ui.setupPluginUi(BloomPlugin)
        ui.setupPluginUi(DepthOfFieldPlugin)
        ui.setupPluginUi(TonemapPlugin)
    }

    if (result.credits) {
        const credits = document.createElement('div')
        credits.style.cssText = 'position:absolute;right:12px;bottom:8px;z-index:1000;max-width:min(480px,calc(100vw - 24px));' +
            'color:#ddd;font:11px/1.4 system-ui,sans-serif;text-shadow:0 1px 2px #000;text-align:right;pointer-events:none'
        credits.textContent = result.credits
        document.body.appendChild(credits)
    }
}

_testStart()
init().finally(_testFinish)
