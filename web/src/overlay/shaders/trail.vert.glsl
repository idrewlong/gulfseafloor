precision highp float;

uniform sampler2D uStatePos;
uniform vec2 uStateSize;

attribute float aId;
attribute float aEnd;

void main() {
  float x = mod(aId, uStateSize.x);
  float y = floor(aId / uStateSize.x);
  vec2 uv = (vec2(x, y) + 0.5) / uStateSize;
  vec4 st = texture(uStatePos, uv);
  vec2 xy = aEnd > 0.5 ? st.xy : st.zw;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, 18.0, 1.0);
}
