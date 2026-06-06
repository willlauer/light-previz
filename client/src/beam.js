import * as THREE from 'three';

// Fake volumetric cone beam.
//
// Geometry: a cone of unit length pointing down -Y. We position+orient the
// containing group so the cone apex sits at the fixture and the axis points
// at the aim target.
//
// Shader: additive, depth-write off, no fog. Inside the fragment we compute
//   r  = radial distance from cone axis (0 at axis, 1 at cone surface)
//   y  = axial distance from apex (0 at apex, 1 at end)
// and combine them into a soft-edged, falling-off intensity.
//
// This is the look-dev fake — no actual volumetric scattering integration.
// It looks good through a foggy scene because Three's exponential fog still
// modulates the rest of the geometry, while the additive beam draws on top.

const BEAM_LENGTH = 14; // world units — long enough to feel like stage throws
const BEAM_BASE_RADIUS = 1.6;
const BEAM_SEGMENTS = 32;
const APEX_Y = -0.155;          // align with lens disc (also at y=-0.155)

// Reusable geometry across beams. CylinderGeometry(radiusTop, radiusBottom, ...)
// places `radiusTop` at y=+h/2 and `radiusBottom` at y=-h/2. We want the narrow
// apex at the top (which we'll translate to sit at the fixture's lens) and the
// wide end at the bottom (which extends in -Y, the beam direction).
const beamGeometry = new THREE.CylinderGeometry(
  0.05,                        // radiusTop — narrow apex, lands at APEX_Y after translate
  BEAM_BASE_RADIUS,            // radiusBottom — wide far end
  BEAM_LENGTH,
  BEAM_SEGMENTS,
  1,
  true                         // open-ended
);
// Shift so the apex sits at the fixture's lens (local y = APEX_Y) and the wide
// end extends in -Y. Original cylinder runs from y=-L/2 to y=+L/2; after the
// translation the top (apex side) is at APEX_Y, the bottom is at APEX_Y - L.
beamGeometry.translate(0, APEX_Y - BEAM_LENGTH / 2, 0);

const beamVert = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const beamFrag = /* glsl */ `
  precision highp float;
  varying vec3 vLocal;
  uniform vec3  uColor;
  uniform float uIntensity;       // 0..1
  uniform float uLength;
  uniform float uBaseRadius;
  uniform float uApexY;           // local y of the cone apex

  void main() {
    // Axial 0 (at apex) -> 1 (at far end). Local y goes uApexY -> uApexY - uLength.
    float t = clamp((uApexY - vLocal.y) / uLength, 0.0, 1.0);

    // Radius of cone at this axial position. Cylinder is wider at the bottom,
    // so the radius is roughly uBaseRadius * t (plus tiny apex radius).
    float coneR = mix(0.05, uBaseRadius, t);

    // Radial distance from cone axis in world units, normalized to coneR.
    float r = length(vLocal.xz) / max(coneR, 0.0001);

    // Soft radial falloff — hot center, soft edge.
    float radial = pow(1.0 - smoothstep(0.0, 1.0, r), 2.0);

    // Axial falloff — STEEP so the source (apex) reads as the brightest point
    // and the beam visibly fades into the haze with distance. Without this
    // steepness the cone's wide end accumulates more additive brightness than
    // the apex (longer integrated path through wider geometry), which makes
    // the beam look like it's coming from the FAR end and pointing at the
    // fixture instead of away from it.
    float axial = pow(1.0 - t, 1.8);

    float a = radial * axial * uIntensity;
    if (a <= 0.001) discard;

    gl_FragColor = vec4(uColor * a, a);
  }
`;

export function createBeam({ color = new THREE.Color(1, 1, 1), length = BEAM_LENGTH, radius = BEAM_BASE_RADIUS } = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor:       { value: color.clone() },
      uIntensity:   { value: 0.0 },
      uLength:      { value: length },
      uBaseRadius:  { value: radius },
      uApexY:       { value: APEX_Y },
    },
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(beamGeometry, material);
  mesh.frustumCulled = false;
  // Beams should not be pickable — they're a visual effect, not a hit target.
  // Without this, the drag raycast (which descends recursively into a fixture
  // root) would pick the 14-unit-long cone instead of the fixture body.
  mesh.raycast = () => {};
  return mesh;
}

export function setBeam(mesh, color, intensity) {
  mesh.material.uniforms.uColor.value.copy(color);
  mesh.material.uniforms.uIntensity.value = intensity;
}
