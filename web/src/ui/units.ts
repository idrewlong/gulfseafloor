/**
 * Depth/elevation units for the chart readouts.
 *
 * The chart works in metres end to end — GEBCO, terrain-RGB and every shader
 * uniform are metres, and nothing here changes that. This is a presentation
 * choice applied at the last step, so a unit swap can never reach the
 * heightfield or the depth window.
 *
 * US chart users read soundings in feet, so the preference is worth keeping
 * between visits. It is the only persisted setting in the viewer; the rest of
 * the controls deliberately reset each load.
 */

export type DepthUnit = 'm' | 'ft';

export const METRES_TO_FEET = 3.28084;

const STORAGE_KEY = 'gulfseafloor.depthUnit';

export function isDepthUnit(value: unknown): value is DepthUnit {
  return value === 'm' || value === 'ft';
}

export function toUnit(metres: number, unit: DepthUnit): number {
  return unit === 'ft' ? metres * METRES_TO_FEET : metres;
}

/**
 * Feet run about 3.3 values to the metre, so a fixed decimal count would show
 * false precision on a −2500 m sounding and none at all in the Sound. Scale
 * the decimals to the magnitude instead.
 */
function decimalsFor(value: number, unit: DepthUnit): number {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return 0;
  }
  if (abs >= 100) {
    return unit === 'ft' ? 0 : 1;
  }
  return 1;
}

/** Signed reading with its unit, e.g. `−32.8 ft`. Uses U+2212, not a hyphen. */
export function formatDepth(metres: number, unit: DepthUnit): string {
  const value = toUnit(metres, unit);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(decimalsFor(value, unit))} ${unit}`;
}

/** Whole-number reading for the legend's end labels, where space is tight. */
export function formatDepthShort(metres: number, unit: DepthUnit): string {
  const value = toUnit(metres, unit);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(0)} ${unit}`;
}

export function loadDepthUnit(): DepthUnit {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isDepthUnit(raw) ? raw : 'm';
  } catch {
    // Private-mode Safari throws on localStorage access rather than returning
    // null. A missing preference is not worth failing a chart load over.
    return 'm';
  }
}

export function saveDepthUnit(unit: DepthUnit): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, unit);
  } catch {
    // Same as above: the preference simply does not persist.
  }
}
