// Author: Alex Albino <dev@alexventure.com>
// Link:   https://github.com/zrecore/3d-viewer-golang
// License: MIT. See LICENSE file.
//
// Lambert shading with a directional light (defined in view space, so it
// follows the camera) plus ambient and a faint fill light.

struct Uniforms {
    mvp: mat4x4<f32>,           // projection * view * model
    normalMatrix: mat4x4<f32>,  // inverse-transpose of (view * model), upper 3x3 used
    lightDir: vec4<f32>,        // view space, pointing TOWARD the light
    baseColor: vec4<f32>,       // rgb surface color
    params: vec4<f32>,          // x: ambient, y: fill strength
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
};

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
};

@vertex
fn vertex_main(in: VertexIn) -> VertexOut {
    var out: VertexOut;
    out.position = u.mvp * vec4<f32>(in.position, 1.0);
    out.normal = (u.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

@fragment
fn fragment_main(in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    var n = normalize(in.normal);
    if (!front) {
        n = -n;
    }
    let l = normalize(u.lightDir.xyz);
    let diffuse = max(dot(n, l), 0.0);
    let fill = max(dot(n, -l), 0.0) * u.params.y;
    let ambient = u.params.x;
    let intensity = min(ambient + diffuse * (1.0 - ambient) + fill, 1.0);
    return vec4<f32>(u.baseColor.rgb * intensity, 1.0);
}
