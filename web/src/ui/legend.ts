import { legendGradientCss } from '../lut';
import { formatDepthShort, type DepthUnit } from './units.ts';

export type LegendOptions = {
  root: HTMLElement;
  min: number;
  max: number;
  unit?: DepthUnit;
};

export function mountLegend(opts: LegendOptions): void {
  const { root, min, max, unit = 'm' } = opts;

  root.innerHTML = `
    <p class="legend-title" id="legend-title">Depth</p>
    <div class="legend-scale">
      <p class="legend-readout legend-readout-max">${formatDepthShort(max, unit)}</p>
      <div class="legend-rail">
        <div class="legend-ramp" aria-hidden="true"></div>
      </div>
      <p class="legend-readout legend-readout-min">${formatDepthShort(min, unit)}</p>
    </div>
    <p class="legend-hint">gulf → Sound → sand</p>
  `;

  const ramp = root.querySelector<HTMLElement>('.legend-ramp');
  if (!ramp) {
    throw new Error('legend markup failed to mount');
  }

  ramp.style.background = legendGradientCss(min, max, min);
  root.dataset.depthMin = String(min);
  root.dataset.depthMax = String(max);
}

/**
 * Relabel the rail's ends. The gradient itself is a function of metres and
 * does not move, so only the two readouts are rewritten.
 */
export function setLegendUnit(root: HTMLElement, unit: DepthUnit): void {
  const min = Number(root.dataset.depthMin ?? 0);
  const max = Number(root.dataset.depthMax ?? 0);
  const lo = root.querySelector<HTMLElement>('.legend-readout-min');
  const hi = root.querySelector<HTMLElement>('.legend-readout-max');
  if (lo) {
    lo.textContent = formatDepthShort(min, unit);
  }
  if (hi) {
    hi.textContent = formatDepthShort(max, unit);
  }
}
