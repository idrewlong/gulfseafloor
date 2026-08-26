uniform sampler2D uVelTex;
uniform sampler2D uStatePos;
uniform vec2 uStateSize;
uniform vec2 uVelSize;
uniform float uOriginLon;
uniform float uOriginLat;
uniform float uMPerDegLon;
uniform float uMPerDegLat;
uniform float uAoiWest;
uniform float uAoiSouth;
uniform float uAoiEast;
uniform float uAoiNorth;
uniform float uGridWest;
uniform float uGridSouth;
uniform float uGridEast;
uniform float uGridNorth;
uniform float uDt;
uniform float uFlowScale;
uniform float uMaxAge;
uniform float uInit;

const float PI = 3.141592653589793;

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 toLocal(float lon, float lat) {
  return vec2((lon - uOriginLon) * uMPerDegLon, (lat - uOriginLat) * uMPerDegLat);
}

vec2 toLonLat(vec2 xy) {
  return vec2(uOriginLon + xy.x / uMPerDegLon, uOriginLat + xy.y / uMPerDegLat);
}

bool inAoi(float lon, float lat) {
  return lon >= uAoiWest && lon <= uAoiEast && lat >= uAoiSouth && lat <= uAoiNorth;
}

bool inGrid(float lon, float lat) {
  return lon >= uGridWest && lon <= uGridEast && lat >= uGridSouth && lat <= uGridNorth;
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

vec4 spawn(float seed) {
  vec2 xy = vec2(0.0);
  float nextSeed = seed;
  for (int i = 0; i < 8; i++) {
    vec2 h = hash22(vec2(nextSeed, nextSeed + 19.19));
    float lon = mix(uAoiWest, uAoiEast, h.x);
    float lat = mix(uAoiSouth, uAoiNorth, h.y);
    xy = toLocal(lon, lat);
    vec4 vel = sampleVel(lon, lat);
    nextSeed += 1.0;
    if (vel.b >= 0.999) {
      break;
    }
  }
  return vec4(xy, 0.0, nextSeed);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uStateSize;
  float id = floor(gl_FragCoord.x) + floor(gl_FragCoord.y) * uStateSize.x;
  vec4 st = texture2D(uStatePos, uv);
  float age = st.z;
  float seed = st.w;
  if (seed < 0.5) {
    seed = id + 1.0;
  }

  vec2 ll = toLonLat(st.xy);
  vec4 vel = sampleVel(ll.x, ll.y);
  bool dead = uInit > 0.5 || age >= uMaxAge || !inAoi(ll.x, ll.y) || vel.b < 0.999;
  if (dead) {
    gl_FragColor = spawn(seed);
    return;
  }

  float lon = ll.x;
  float lat = ll.y;
  float metresEast = vel.r * uDt * uFlowScale;
  float metresNorth = vel.g * uDt * uFlowScale;
  float mPerDegLonNow = uMPerDegLat * cos(lat * PI / 180.0);
  lon += metresEast / mPerDegLonNow;
  lat += metresNorth / uMPerDegLat;
  gl_FragColor = vec4(toLocal(lon, lat), age + uDt, seed);
}
