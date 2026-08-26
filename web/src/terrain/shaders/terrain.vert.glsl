precision highp float;

uniform sampler2D uHeightTex;
uniform float uExaggeration;
uniform float uTileSpanMeters;
uniform vec2  uUvOffset;
uniform vec2  uUvScale;
uniform vec2  uTexelSize;

out vec2  vUv;
out float vElevation;
out float vViewDist;
out vec3  vWorldPos;
out float vSkirt;

float sampleElev(vec2 uv) {
  return texture(uHeightTex, uv).r;
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

  float raw = sampleElev(vUv);
  float elev = raw > -9999.0 ? raw : validElev(vUv);
  vElevation = raw;

  vec3 pos = position;
  pos.z = (elev / uTileSpanMeters) * uExaggeration;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
  vViewDist = length(viewPos.xyz);
  gl_Position = projectionMatrix * viewPos;
}
