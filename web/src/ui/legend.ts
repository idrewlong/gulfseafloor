import { legendGradientCss } from '../lut';

export type LegendOptions = {
  root: HTMLElement;
  min: number;
  max: number;
};

function formatMetres(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(0)} m`;
}

export function mountLegend(opts: LegendOptions): void {
  const { root, min, max } = opts;

  root.innerHTML = `
    <p class="legend-title" id="legend-title">Depth</p>
    <div class="legend-scale">
      <p class="legend-readout legend-readout-max">${formatMetres(max)}</p>
      <div class="legend-rail">
        <div class="legend-ramp" aria-hidden="true"></div>
      </div>
      <p class="legend-readout legend-readout-min">${formatMetres(min)}</p>
    </div>
    <p class="legend-hint">gulf → Sound → sand</p>
  `;

  const ramp = root.querySelector<HTMLElement>('.legend-ramp');
  if (!ramp) {
    throw new Error('legend markup failed to mount');
  }

  ramp.style.background = legendGradientCss(min, max, min);
}
