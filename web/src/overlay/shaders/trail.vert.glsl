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
uniform float uFlowScale;
uniform float uTrailLag;

attribute float aId;
attribute float aEnd;

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

void main() {
  float x = mod(aId, uStateSize.x);
  float y = floor(aId / uStateSize.x);
  vec2 uv = (vec2(x, y) + 0.5) / uStateSize;
  vec4 st = texture2D(uStatePos, uv);
  vec2 head = st.xy;
  vec2 ll = toLonLat(head);
  vec4 vel = sampleVel(ll.x, ll.y);
  vec2 tail = head - vec2(vel.r, vel.g) * uTrailLag * uFlowScale;
  vec2 xy = aEnd > 0.5 ? head : tail;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, 18.0, 1.0);
}
