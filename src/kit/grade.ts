import {AScreenPassExtensionPlugin, Color} from 'threepipe'

/**
 * Final color grade of the world scenes, after tone mapping: warm highlights and cool shadows (split toning, the
 * temperature difference between sun and sky light that a photographed sky gives), and a saturation trim so grass
 * and painted walls do not turn neon. Values near 1 are subtle on purpose.
 */
export class ColorGradePlugin extends AScreenPassExtensionPlugin {
    static readonly PluginType = 'WorldColorGrade'
    enabled = true
    /** Applied after tone mapping, before the vignette. */
    priority = -45

    readonly extraUniforms = {
        gradeShadows: {value: new Color(0.96, 0.99, 1.05)},
        gradeHighlights: {value: new Color(1.05, 1.0, 0.93)},
        gradeSaturation: {value: 0.92},
    }

    parsFragmentSnippet = () => this.isDisabled() ? '' : /* glsl */`
        uniform vec3 gradeShadows;
        uniform vec3 gradeHighlights;
        uniform float gradeSaturation;
        vec4 WorldColorGrade(in vec4 c) {
            float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            c.rgb *= mix(gradeShadows, gradeHighlights, smoothstep(0.05, 0.8, l));
            c.rgb = max(mix(vec3(l), c.rgb, gradeSaturation), 0.0);
            return c;
        }
    `

    protected _shaderPatch = 'diffuseColor = WorldColorGrade(diffuseColor);'

    /** Set the grade; omitted values keep their current setting. */
    set(o: {shadows?: [number, number, number], highlights?: [number, number, number], saturation?: number}) {
        if (o.shadows) this.extraUniforms.gradeShadows.value.setRGB(...o.shadows)
        if (o.highlights) this.extraUniforms.gradeHighlights.value.setRGB(...o.highlights)
        if (o.saturation !== undefined) this.extraUniforms.gradeSaturation.value = o.saturation
        this.setDirty()
    }
}
