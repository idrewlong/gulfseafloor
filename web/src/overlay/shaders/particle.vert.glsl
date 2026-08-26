uniform sampler2D uStatePos;
uniform vec2 uStateSize;
uniform float uPointSize;

attribute float aId;

void main() {
  float x = mod(aId, uStateSize.x);
  float y = floor(aId / uStateSize.x);
  vec2 uv = (vec2(x, y) + 0.5) / uStateSize;
  vec4 st = texture2D(uStatePos, uv);
  gl_PointSize = uPointSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(st.xy, 18.0, 1.0);
}
