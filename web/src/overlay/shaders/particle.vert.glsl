uniform sampler2D uVelTex;
uniform sampler2D uStatePos;
uniform vec2 uStateSize;
uniform vec2 uVelSize;
uniform float uOriginLon;
uniform float uOriginLat;
uniform float uMPerDegLon;
uniform float uMPerDegLat;
uniform float uGridWest;
uniform float uGridSouth;
uniform float uGridEast;
uniform float uGridNorth;
uniform float uSpeedMax;
uniform float uPointSize;

attribute float aId;

varying float vSpeed;
varying vec3 vColor;

bool inGrid(float lon, float lat) {
  return lon >= uGridWest && lon <= uGridEast && lat >= uGridSouth && lat <= uGridNorth;
}

vec2 toLonLat(vec2 xy) {
  return vec2(uOriginLon + xy.x / uMPerDegLon, uOriginLat + xy.y / uMPerDegLat);
}

vec4 sampleVel(float lon, float lat) {
  if (!inGrid(lon, lat) || uVelSize.x < 1.0 || uVelSize.y < 1.0) {
    return vec4(0.0);
  }
  float nx = uVelSize.x;
  float ny = uVelSize.y;
  float fx = nx <= 1.0 ? 0.0 : ((lon - uGridWest) / (uGridEast - uGridWest)) * (nx - 1.0);
  float fy = ny <= 1.0 ? 0.0 : ((lat - uGridSouth) / (uGridNorth - uGridSouth)) * (ny - 1.0);
  vec2 velUv = (vec2(fx, fy) + 0.5) / vec2(nx, ny);
  return texture2D(uVelTex, velUv);
}

// Ramp must match speedRamp.ts. Faster reads brighter.
vec3 speedColor(float speedMs) {
  float f = clamp(speedMs / uSpeedMax, 0.0, 1.0);
  vec3 c0 = vec3(0.09, 0.13, 0.36);
  vec3 c1 = vec3(0.13, 0.42, 0.63);
  vec3 c2 = vec3(0.25, 0.72, 0.78);
  vec3 c3 = vec3(0.55, 0.90, 0.75);
  vec3 c4 = vec3(0.97, 0.95, 0.70);
  float s = f * 4.0;
  vec3 c = mix(c0, c1, clamp(s, 0.0, 1.0));
  c = mix(c, c2, clamp(s - 1.0, 0.0, 1.0));
  c = mix(c, c3, clamp(s - 2.0, 0.0, 1.0));
  c = mix(c, c4, clamp(s - 3.0, 0.0, 1.0));
  return c;
}

void main() {
  float x = mod(aId, uStateSize.x);
  float y = floor(aId / uStateSize.x);
  vec2 uv = (vec2(x, y) + 0.5) / uStateSize;
  vec4 st = texture2D(uStatePos, uv);

  vec2 ll = toLonLat(st.xy);
  vec4 vel = sampleVel(ll.x, ll.y);
  float speed = length(vel.rg);
  vSpeed = speed;
  vColor = speedColor(speed);

  gl_PointSize = uPointSize * (0.6 + 0.6 * clamp(speed / uSpeedMax, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(st.xy, 18.0, 1.0);
}
