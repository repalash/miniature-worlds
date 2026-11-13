import {
    Box3B,
    Color,
    DirectionalLight2,
    getUrlQueryParam,
    IObject3D,
    Mesh,
    PhysicalMaterial,
    PointLight2,
    SphereGeometry,
    SRGBColorSpace,
    ThreeViewer,
    TonemapPlugin,
    UiObjectConfig,
    Vector3,
} from 'threepipe'

/**
 * Black-body color of a light source in sRGB (Tanner Helland's curve fit of the Planckian locus, 1000-40000 K).
 */
export function kelvinToColor(kelvin: number, target = new Color()) {
    const t = kelvin / 100
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
    const c = (x: number) => Math.min(255, Math.max(0, x)) / 255
    return target.setRGB(c(r), c(g), c(b), SRGBColorSpace)
}

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
}

export interface LightingPreset {
    /** Sun on/off, direction in degrees, peak intensity (three.js physical units, lux-like). */
    sun?: {enabled?: boolean, azimuth?: number, elevation?: number, intensity?: number, kelvin?: number, autoColor?: boolean, shadowMapSize?: number}
    /** Environment (IBL) intensity. Keep it low so bounce light is not drowned. */
    environment?: number
    /** Colored point lights orbiting the scene center. */
    movers?: {enabled?: boolean, count?: number, intensity?: number, height?: number, radius?: number}
    exposure?: number
    /** Region the sun's shadow covers, when the scene bounds are larger than the part in view. */
    fit?: {center: [number, number, number], radius: number}
}

/**
 * Lighting for the demo scenes: a shadow-casting sun fitted to the scene bounds, with a color temperature that
 * follows its elevation (warm and dim near the horizon, white at noon) and an optional rotation over time; and
 * colored point lights that orbit the scene, to show the GI following moving lights.
 */
export class LightingRig {
    readonly sun = new DirectionalLight2()
    readonly sunState = {enabled: true, azimuth: 135, elevation: 25, intensity: 5, kelvin: 5500, autoColor: true, animate: false, speed: 12}
    readonly moverState = {enabled: false, count: 3, intensity: 1, height: 0.35, radius: 0.55, speed: 0.6, shadows: false}
    readonly movers: {light: PointLight2, orb: IObject3D}[] = []
    private _bounds = new Box3B()
    private _center = new Vector3()
    private _radius = 1
    private _time = 0

    constructor(readonly viewer: ThreeViewer) {
        this.sun.name = 'Demo sun'
        this.sun.castShadow = true
        // ?shadow=<size> overrides the shadow map size (e.g. 512 for software rendering in tests)
        this.sun.shadowMapSize.setScalar(+(getUrlQueryParam('shadow') ?? 2048) || 2048)
        this.sun.shadowBias = -0.0002
        viewer.scene.addObject(this.sun)
        viewer.scene.addObject(this.sun.target)
        viewer.addEventListener('preFrame', (e: any) => this._tick(e.deltaTime ?? 16))
    }

    /** Fit the sun's shadow frustum and the movers' orbit to the current scene bounds. */
    fitToScene(fit?: LightingPreset['fit']) {
        this._bounds = this.viewer.scene.getBounds(false, true)
        this._bounds.getCenter(this._center)
        this._radius = Math.max(0.1, this._bounds.getSize(new Vector3()).length() / 2)
        if (fit) {
            this._center.set(...fit.center)
            this._radius = fit.radius
        }
        this.updateSun()
        this._rebuildMovers()
    }

    apply(preset: LightingPreset) {
        const {shadowMapSize, ...sun} = preset.sun ?? {}
        Object.assign(this.sunState, sun)
        if (shadowMapSize && !getUrlQueryParam('shadow') && this.sun.shadowMapSize.x !== shadowMapSize) {
            this.sun.shadowMapSize.setScalar(shadowMapSize)
            // three.js keeps the old shadow map target when mapSize changes: the new size renders into the old
            // texture, and the shadows land in the wrong place. Drop it so the next shadow pass makes a new one.
            this.sun.shadow.map?.dispose()
            this.sun.shadow.map = null
        }
        if (preset.environment !== undefined) this.viewer.scene.environmentIntensity = preset.environment
        Object.assign(this.moverState, preset.movers ?? {})
        if (preset.exposure !== undefined) {
            const tonemap = this.viewer.getPlugin(TonemapPlugin)
            if (tonemap) tonemap.exposure = preset.exposure
        }
        this.fitToScene(preset.fit)
    }

    /** Called after every sun update (a world scene keeps its sky turned to the sun with it). */
    onSunUpdate?: () => void

    updateSun() {
        const s = this.sunState
        const az = s.azimuth * Math.PI / 180, el = s.elevation * Math.PI / 180
        const dir = new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
        this.sun.visible = s.enabled
        this.sun.position.copy(this._center).addScaledVector(dir, this._radius * 2)
        this.sun.target.position.copy(this._center)
        this.sun.target.updateMatrixWorld()
        this.sun.shadowFrustum = this._radius * 2.2
        this.sun.shadowNear = 0.01 * this._radius
        this.sun.shadowFar = this._radius * 4.5
        // About two shadow-map texels: enough against acne, small enough to keep contact shadows attached.
        this.sun.shadowNormalBias = 2 * this.sun.shadowFrustum / this.sun.shadowMapSize.x
        // Near the horizon the sun is redder and dimmer (longer path through the atmosphere).
        const kelvin = s.autoColor ? 1900 + 3900 * Math.pow(smoothstep(-2, 50, s.elevation), 0.8) : s.kelvin
        kelvinToColor(kelvin, this.sun.color)
        this.sun.intensity = s.intensity * (s.autoColor ? 0.25 + 0.75 * smoothstep(-2, 25, s.elevation) : 1)
        this.sun.setDirty({refreshUi: false})
        this.onSunUpdate?.()
    }

    private _rebuildMovers() {
        for (const m of this.movers) {
            m.light.removeFromParent()
            m.orb.removeFromParent()
        }
        this.movers.length = 0
        if (!this.moverState.enabled) {
            this.viewer.setDirty()
            return
        }
        const colors = ['#ff5a2a', '#2f6bff', '#2cff6a', '#ff2fd2', '#ffd22f']
        for (let i = 0; i < this.moverState.count; i++) {
            const color = new Color(colors[i % colors.length])
            // Point lights in candela with physical decay: scale with the orbit size so the illuminance stays similar.
            const light = new PointLight2(color, 1, 0, 2)
            light.castShadow = this.moverState.shadows
            light.shadowMapSize.setScalar(512)
            this.viewer.scene.addObject(light)
            const orb = this.viewer.scene.addObject(new Mesh(new SphereGeometry(this._radius * 0.015, 16, 12),
                new PhysicalMaterial({color: '#000000', emissive: color, emissiveIntensity: 8})))
            orb.castShadow = false
            this.movers.push({light, orb})
        }
        this._placeMovers()
    }

    private _placeMovers() {
        const s = this.moverState
        const r = this._radius * s.radius
        const lightIntensity = s.intensity * 4 * r * r // ~4 lux at the orbit radius
        this.movers.forEach((m, i) => {
            const a = this._time * s.speed + i * Math.PI * 2 / this.movers.length
            const y = this._bounds.min.y + (this._bounds.max.y - this._bounds.min.y) * s.height * (1 + 0.3 * Math.sin(this._time * 0.7 + i))
            m.light.position.set(this._center.x + Math.cos(a) * r, y, this._center.z + Math.sin(a) * r)
            m.light.intensity = lightIntensity
            m.orb.position.copy(m.light.position)
            m.light.setDirty({refreshUi: false})
            m.orb.setDirty?.({refreshUi: false})
        })
    }

    private _tick(deltaMs: number) {
        const dt = Math.min(deltaMs, 50) / 1000
        if (this.sunState.enabled && this.sunState.animate) {
            this.sunState.azimuth = (this.sunState.azimuth + this.sunState.speed * dt) % 360
            this.updateSun()
        }
        if (this.moverState.enabled && this.movers.length) {
            this._time += dt
            this._placeMovers()
        }
    }

    uiConfig(): UiObjectConfig {
        const sun = () => this.updateSun()
        const movers = () => this._rebuildMovers()
        const tonemap = this.viewer.getPlugin(TonemapPlugin)
        return {
            type: 'folder',
            label: 'Lighting',
            expanded: true,
            children: [
                {type: 'checkbox', label: 'Sun', property: [this.sunState, 'enabled'], onChange: sun},
                {type: 'slider', label: 'Sun azimuth', bounds: [0, 360], stepSize: 1, property: [this.sunState, 'azimuth'], onChange: sun},
                {type: 'slider', label: 'Sun elevation', bounds: [-5, 90], stepSize: 0.5, property: [this.sunState, 'elevation'], onChange: sun},
                {type: 'slider', label: 'Sun intensity', bounds: [0, 20], stepSize: 0.1, property: [this.sunState, 'intensity'], onChange: sun},
                {type: 'checkbox', label: 'Sun color from elevation', property: [this.sunState, 'autoColor'], onChange: sun},
                {type: 'slider', label: 'Sun temperature (K)', bounds: [1500, 10000], stepSize: 50, property: [this.sunState, 'kelvin'], onChange: sun},
                {type: 'checkbox', label: 'Rotate sun', property: [this.sunState, 'animate']},
                {type: 'slider', label: 'Sun speed (deg/s)', bounds: [1, 90], stepSize: 1, property: [this.sunState, 'speed']},
                {type: 'checkbox', label: 'Moving colored lights', property: [this.moverState, 'enabled'], onChange: movers},
                {type: 'slider', label: 'Moving lights count', bounds: [1, 5], stepSize: 1, property: [this.moverState, 'count'], onChange: movers},
                {type: 'slider', label: 'Moving lights intensity', bounds: [0, 10], stepSize: 0.1, property: [this.moverState, 'intensity']},
                {type: 'slider', label: 'Moving lights height', bounds: [0, 1], stepSize: 0.01, property: [this.moverState, 'height']},
                {type: 'checkbox', label: 'Moving light shadows', property: [this.moverState, 'shadows'], onChange: movers},
                {type: 'slider', label: 'Environment intensity', bounds: [0, 2], stepSize: 0.01,
                    property: [this.viewer.scene, 'environmentIntensity'], onChange: () => this.viewer.setDirty()},
                ...tonemap ? [{type: 'slider', label: 'Exposure', bounds: [0.1, 4], stepSize: 0.01, property: [tonemap, 'exposure'],
                    onChange: () => this.viewer.setDirty()} as UiObjectConfig] : [],
            ],
        }
    }
}
