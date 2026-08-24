precision highp float;

uniform sampler2D uHeightTex;
uniform float uExaggeration;
uniform float uTileSpanMeters;
uniform vec2  uUvOffset;
uniform vec2  uUvScale;
uniform vec2  uTexelSize;
uniform float uSkirtDrop;

out vec2  vUv;
out float vElevation;
out float vViewDist;
out vec3  vWorldPos;
out float vSkirt;

float decodeTerrarium(vec3 rgb) {
  return -10000.0 + ((rgb.r * 255.0 * 65536.0
                    + rgb.g * 255.0 * 256.0
                    + rgb.b * 255.0) * 0.1);
}

float sampleElev(vec2 uv) {
  return decodeTerrarium(texture(uHeightTex, uv).rgb);
}

float validElev(vec2 uv) {
  float elev = sampleElev(uv);
  if (elev > -9999.0) {
    return elev;
  }
  vec2 t = uTexelSize;
  float e;
  e = sampleElev(uv + vec2(t.x, 0.0));
  if (e > -9999.0) { return e; }
  e = sampleElev(uv - vec2(t.x, 0.0));
  if (e > -9999.0) { return e; }
  e = sampleElev(uv + vec2(0.0, t.y));
  if (e > -9999.0) { return e; }
  e = sampleElev(uv - vec2(0.0, t.y));
  if (e > -9999.0) { return e; }
  return 0.0;
}

void main() {
  vec2 innerUv = clamp(uv, 0.0, 1.0);
  vSkirt = float(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0);
  vUv = innerUv * uUvScale + uUvOffset;

  float elev = validElev(vUv);
  float land = smoothstep(-0.25, 0.45, elev);
  float blur = 4.0;
  vec2 t = uTexelSize * blur;
  float smoothElev = (
    elev
    + validElev(vUv + vec2(t.x, 0.0))
    + validElev(vUv - vec2(t.x, 0.0))
    + validElev(vUv + vec2(0.0, t.y))
    + validElev(vUv - vec2(0.0, t.y))
  ) * 0.2;
  float disp = mix(smoothElev, elev, land);

  vElevation = sampleElev(vUv);

  vec3 pos = position;
  pos.z = (disp / uTileSpanMeters) * uExaggeration * mix(0.55, 1.0, land);
  if (vSkirt > 0.0) {
    // Exaggerated with the terrain. A fixed drop is invisible at 50x and taller
    // than the whole depth range at 1x, where it turns every tile edge into a
    // wall across the map.
    pos.z -= uSkirtDrop * uExaggeration;
  }

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
  vViewDist = length(viewPos.xyz);
  gl_Position = projectionMatrix * viewPos;
}
