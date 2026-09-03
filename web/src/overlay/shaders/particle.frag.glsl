varying float vSpeed;
varying vec3 vColor;

void main() {
  gl_FragColor = vec4(vColor, 0.95 * smoothstep(0.0, 0.05, vSpeed));
}
