// Converged stills of a tile in a headless browser, with GI on and (optionally) off, plus the page's console errors.
//
//   npm run shot -- --tile alpine --view Diorama --off 1
//   npm run shot -- --tile alpine --view Bridge --time Alpenglow --w 1280 --h 720 --frames 64 --out shots/alpine
//   npm run shot -- --url https://example.com/my-build/ --tile alpine      (a deployed build instead of the dev server)
//   npm run shot -- --tile alpine --measure 1                               (also a frame-time measurement per view)
//
// Options: --base (dev server, default http://localhost:5173), --views "Diorama,Bridge" (several views),
// --frames (progressive frames to converge, default 48), --t (animation time), --eval "<js run after load>".
// Writes <out>/<view>-on.jpg (and -off.jpg). Needs Chromium: `npm run shot:install` once, or CHROMIUM_BIN=<path>.
// Headless Chromium renders with SwiftShader (on the CPU) unless you pass --gpu 1 on a machine with a GPU: fine for
// checking composition and errors, slow, and its frame times mean nothing. Measure frame time in a real browser tab.
import {chromium} from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]])
    return a
}, []))
const base = args.url ?? args.base ?? 'http://localhost:5173/'
const tile = args.tile ?? 'alpine'
const W = +(args.w ?? 960), H = +(args.h ?? 540), frames = +(args.frames ?? 48)
const out = args.out ?? path.join('shots', tile)
const views = args.views ? args.views.split(',') : [args.view ?? '']
fs.mkdirSync(out, {recursive: true})

const browser = await chromium.launch({
    ...(process.env.CHROMIUM_BIN ? {executablePath: process.env.CHROMIUM_BIN} : {}),
    args: [
        ...args.gpu === '1' ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default']
            : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        // CHROMIUM_PROXY=<url>: send remote requests through a proxy (local requests stay direct)
        ...process.env.CHROMIUM_PROXY ? [`--proxy-server=${process.env.CHROMIUM_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [],
    ],
})
const page = await browser.newPage({viewport: {width: W, height: H}})
const errors = []
page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 300))
    else if (m.text().includes('setup in') || m.text().includes('frame time')) console.log('page:', m.text())
})
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

for (const view of views) {
    const q = new URLSearchParams({tile, ui: '0', ...(args.shadow ? {shadow: args.shadow} : {})})
    if (view) q.set('view', view)
    if (args.time) q.set('time', args.time)
    const t0 = Date.now()
    await page.goto(`${base}${base.includes('?') ? '&' : '?'}${q}`, {waitUntil: 'load'})
    await page.waitForSelector('body._testFinish', {state: 'attached', timeout: 600000})
    console.log(`loaded ${tile} ${view || '(first view)'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    await page.addStyleTag({content: '.loading-screen {display:none !important}'})
    if (args.eval) await page.evaluate(args.eval)
    const name = (view || 'start').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    for (const gi of args.off === '1' ? [true, false] : [true]) {
        const data = await page.evaluate(async({gi, frames, t}) => {
            const {viewer: v, ssgi, state, result} = window.miniWorld
            const controls = v.scene.mainCamera.controls
            if (controls) { controls.enableDamping = false; controls.autoRotate = false }
            state.animate = false; state.cameraPath = false; state.orbit = false
            if (t !== undefined && result.animate) result.animate(+t)
            ssgi.enabled = gi
            v.setDirty()
            await new Promise(res => {
                let n = 0
                const post = () => { if (++n >= frames) { v.removeEventListener('postFrame', post); res() } }
                v.addEventListener('postFrame', post)
            })
            return v.canvas.toDataURL('image/jpeg', 0.92)
        }, {gi, frames, t: args.t})
        const file = path.join(out, `${name}-${gi ? 'on' : 'off'}.jpg`)
        fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'))
        console.log('wrote', file)
    }
    if (args.measure === '1') await page.evaluate(() => window.miniWorld.measureFrameTime())
}
if (errors.length) console.log('console:\n' + [...new Set(errors)].slice(0, 30).join('\n'))
await browser.close()
