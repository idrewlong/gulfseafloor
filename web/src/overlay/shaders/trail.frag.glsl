varying float vT;
varying float vSpeed;
varying vec3 vColor;

void main() {
  // Alpha taper, not width: WebGL ignores lineWidth. Genuine width taper
  // would need quad-expanded ribbons.
  float taper = pow(1.0 - vT, 1.5);
  // Slack water fades out rather than sitting as a field of static marks.
  float alive = smoothstep(0.0, 0.05, vSpeed);
  gl_FragColor = vec4(vColor, 0.85 * taper * alive);
}
