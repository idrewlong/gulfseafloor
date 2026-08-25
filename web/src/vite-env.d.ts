/// <reference types="vite/client" />

declare const CESIUM_BASE_URL: string;

declare module '*.glsl?raw' {
  const source: string;
  export default source;
}
