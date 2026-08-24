import { LUT_CSS_GRADIENT } from '../lut';

export type DepthWindow = {
  min: number;
  max: number;
};

export type LegendOptions = {
  root: HTMLElement;
  minLimit: number;
  maxLimit: number;
  initial: DepthWindow;
  onChange: (window: DepthWindow) => void;
};

function formatMetres(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(0)} m`;
}

export function mountLegend(opts: LegendOptions): {
  setWindow: (w: DepthWindow) => void;
} {
  const { root, minLimit, maxLimit, initial, onChange } = opts;

  root.innerHTML = `
    <p class="legend-title" id="legend-title">Depth window</p>
    <div class="legend-scale">
      <output class="legend-readout legend-readout-max" id="legend-max-out" for="legend-max">${formatMetres(initial.max)}</output>
      <div class="legend-rail">
        <div class="legend-ramp" aria-hidden="true"></div>
        <label class="legend-handle legend-handle-max">
          <span class="visually-hidden">Shallower bound of the depth window, metres</span>
          <input
            id="legend-max"
            type="range"
            min="${minLimit}"
            max="${maxLimit}"
            step="1"
            value="${initial.max}"
            aria-valuemin="${minLimit}"
            aria-valuemax="${maxLimit}"
            aria-labelledby="legend-title"
          />
        </label>
        <label class="legend-handle legend-handle-min">
          <span class="visually-hidden">Deeper bound of the depth window, metres</span>
          <input
            id="legend-min"
            type="range"
            min="${minLimit}"
            max="${maxLimit}"
            step="1"
            value="${initial.min}"
            aria-valuemin="${minLimit}"
            aria-valuemax="${maxLimit}"
            aria-labelledby="legend-title"
          />
        </label>
      </div>
      <output class="legend-readout legend-readout-min" id="legend-min-out" for="legend-min">${formatMetres(initial.min)}</output>
    </div>
    <p class="legend-hint">gulf → Sound → sand</p>
  `;

  const ramp = root.querySelector<HTMLElement>('.legend-ramp');
  const minInput = root.querySelector<HTMLInputElement>('#legend-min');
  const maxInput = root.querySelector<HTMLInputElement>('#legend-max');
  const minOut = root.querySelector<HTMLOutputElement>('#legend-min-out');
  const maxOut = root.querySelector<HTMLOutputElement>('#legend-max-out');

  if (!ramp || !minInput || !maxInput || !minOut || !maxOut) {
    throw new Error('legend markup failed to mount');
  }

  ramp.style.background = LUT_CSS_GRADIENT;

  const emit = (): void => {
    let min = Number(minInput.value);
    let max = Number(maxInput.value);
    if (min > max - 1) {
      if (document.activeElement === minInput) {
        min = max - 1;
        minInput.value = String(min);
      } else {
        max = min + 1;
        maxInput.value = String(max);
      }
    }
    minOut.textContent = formatMetres(min);
    maxOut.textContent = formatMetres(max);
    minInput.setAttribute('aria-valuenow', String(min));
    maxInput.setAttribute('aria-valuenow', String(max));
    onChange({ min, max });
  };

  minInput.addEventListener('input', emit);
  maxInput.addEventListener('input', emit);

  return {
    setWindow(w: DepthWindow): void {
      minInput.value = String(w.min);
      maxInput.value = String(w.max);
      minOut.textContent = formatMetres(w.min);
      maxOut.textContent = formatMetres(w.max);
    },
  };
}
