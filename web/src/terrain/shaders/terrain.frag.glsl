precision highp float;

uniform sampler2D uHeightTex;
uniform sampler2D uColorLUT;
uniform vec2  uTexelSize;
uniform vec3  uSunDir;
uniform float uContourInterval;
uniform float uDepthMin;
uniform float uDepthMax;
uniform float uExaggeration;
uniform float uTileSpanMeters;
uniform float uTileSpanY;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform sampler2D uImageryTex;
uniform float uImageryOpacity;
uniform float uHasImagery;

in vec2  vUv;
in float vElevation;
in float vViewDist;
in vec3  vWorldPos;
in float vSkirt;

out vec4 fragColor;

float sampleElev(vec2 uv) {
  return texture(uHeightTex, uv).r;
}

float validElev(vec2 uv) {
  float elev = sampleElev(clamp(uv, 0.0, 1.0));
  if (elev > -9999.0) {
    return elev;
  }
  return vElevation > -9999.0 ? vElevation : 0.0;
}

void main() {
  if (vElevation <= -9999.0) {
    discard;
  }

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 geoN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  // Skirt ring, plus steep faces only when the camera is edge-on to the
  // slab. Unconditional steep-face discard would eat 50× bathymetry from above.
  if (vSkirt > 0.0 || (abs(geoN.z) < 0.35 && viewDir.z < 0.25)) {
    discard;
  }

  float dx = max(2.0 * uTexelSize.x * uTileSpanMeters, 1.0);
  float dy = max(2.0 * uTexelSize.y * uTileSpanY, 1.0);
  float l = validElev(vUv - vec2(uTexelSize.x, 0.0));
  float r = validElev(vUv + vec2(uTexelSize.x, 0.0));
  float dn = validElev(vUv - vec2(0.0, uTexelSize.y));
  float up = validElev(vUv + vec2(0.0, uTexelSize.y));

  // Colour from a per-fragment sample, not the vertex varying. The mesh is one
  // cell per 2x2 texels, so reading the interpolated vertex value painted any
  // pond smaller than a cell as a flat, hard-edged facet — the six triangles
  // meeting at that vertex, i.e. a hexagon. The normals below already sample
  // per fragment; this puts the colour on the same footing.
  float elev = validElev(vUv);
  float depth = max(-elev, 0.0);
  float land = smoothstep(-0.25, 0.45, elev);

  vec3 nrm = normalize(vec3(
    -(r - l) * uExaggeration / dx,
    -(up - dn) * uExaggeration / dy,
    1.0
  ));

  vec3 sun = normalize(uSunDir);
  float ndotl = dot(nrm, sun);
  float wrap = clamp(ndotl * 0.42 + 0.58, 0.0, 1.0);
  float lambert = clamp(ndotl, 0.0, 1.0);
  float shade = mix(wrap, lambert, mix(0.45, 0.78, land));

  vec3 sandWet = vec3(0.55, 0.47, 0.34);
  vec3 sandDry = vec3(0.89, 0.80, 0.58);
  vec3 dune = vec3(0.76, 0.66, 0.45);
  vec3 scrub = vec3(0.38, 0.44, 0.30);
  vec3 beach = mix(sandWet, sandDry, smoothstep(-0.15, 0.9, elev));
  beach = mix(beach, dune, smoothstep(0.6, 2.0, elev));
  vec3 ground = mix(beach, scrub, smoothstep(1.5, 3.3, elev));

  // Beer–Lambert through turbid Sound water; sand bed only in the last metre.
  float gulf = smoothstep(2.0, max(12.0, -uDepthMin * 0.45), depth);
  vec3 scatter = mix(
    mix(vec3(0.42, 0.62, 0.58), vec3(0.20, 0.40, 0.42), smoothstep(1.0, 8.0, depth)),
    vec3(0.12, 0.30, 0.40),
    gulf
  );
  float absorb = 1.0 - exp(-mix(0.50, 0.10, gulf) * depth);
  vec3 water = mix(vec3(0.62, 0.58, 0.42), scatter, absorb);

  float foam = (1.0 - land) * (1.0 - smoothstep(-0.45, 0.12, elev));
  water = mix(water, vec3(0.88, 0.91, 0.90), foam * 0.22);

  vec3 base = mix(water, ground, land);

  vec3 ambient = mix(vec3(0.14, 0.22, 0.24), vec3(0.18, 0.17, 0.13), land);
  vec3 color = base * mix(0.42, 1.06, pow(shade, 0.85)) + ambient * (1.0 - lambert);

  vec3 halfv = normalize(sun + viewDir);
  float spec = pow(max(dot(nrm, halfv), 0.0), mix(42.0, 16.0, land)) * mix(0.10, 0.07, land);
  float fresnel = pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 3.0);
  color += vec3(0.82, 0.90, 0.92) * spec;
  color += uFogColor * fresnel * mix(0.12, 0.05, land);
  color *= mix(1.0, 0.97, vSkirt);

  if (uImageryOpacity > 0.001 && uHasImagery > 0.5) {
    vec3 img = texture(uImageryTex, vUv).rgb;
    vec3 draped = img * (0.68 + 0.32 * shade);
    float amt = clamp(uImageryOpacity, 0.0, 1.0);
    color = mix(color, draped, amt);
  }

  if (uContourInterval > 0.0) {
    float f  = elev / uContourInterval;
    float df = fwidth(f);
    float line = 1.0 - smoothstep(0.0, df * 1.5, abs(fract(f) - 0.5) - 0.5 + df);
    color = mix(color, vec3(0.12, 0.10, 0.08), line * 0.4);
  }

  float fog = 1.0 - exp(-uFogDensity * vViewDist);
  color = mix(color, uFogColor, clamp(fog, 0.0, 0.5));

  fragColor = vec4(color, 1.0);
}
