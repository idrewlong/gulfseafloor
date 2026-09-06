import { setDetail, setPosition, type DetailBlock, type ElevationSample } from './inspector.ts';
import { isDepthUnit, type DepthUnit } from './units.ts';

// Re-exported so existing callers keep importing these from controls.
export { formatLat, formatLon, formatElevation } from './format.ts';

export type ViewerControls = {
  exaggeration: number;
  contourInterval: number;
  sunAzimuth: number;
  sunAltitude: number;
  currents: boolean;
  buoys: boolean;
  aircraft: boolean;
  /** Readout units only. The chart itself is metres throughout. */
  units: DepthUnit;
};

export type ControlsHandle = {
  get(): ViewerControls;
  setExaggeration(value: number): void;
};

export function sunDirection(azimuthDeg: number, altitudeDeg: number): {
  x: number;
  y: number;
  z: number;
} {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (altitudeDeg * Math.PI) / 180;
  return {
    x: Math.sin(az) * Math.cos(el),
    y: Math.cos(az) * Math.cos(el),
    z: Math.sin(el),
  };
}


export function mountControls(
  form: HTMLFormElement,
  initial: ViewerControls,
  onChange: (state: ViewerControls) => void,
): ControlsHandle {
  const exaggeration = form.querySelector<HTMLInputElement>('#exaggeration');
  const exaggerationOut = form.querySelector<HTMLOutputElement>('#exaggeration-out');
  const contour = form.querySelector<HTMLFieldSetElement>('#contours');
  const azimuth = form.querySelector<HTMLInputElement>('#sun-azimuth');
  const azimuthOut = form.querySelector<HTMLOutputElement>('#sun-azimuth-out');
  const altitude = form.querySelector<HTMLInputElement>('#sun-altitude');
  const altitudeOut = form.querySelector<HTMLOutputElement>('#sun-altitude-out');
  const layers = form.querySelector<HTMLFieldSetElement>('#layers');
  const units = form.querySelector<HTMLFieldSetElement>('#units');

  if (!exaggeration || !exaggerationOut || !contour || !azimuth || !azimuthOut || !altitude || !altitudeOut || !layers || !units) {
    throw new Error('control markup is incomplete');
  }

  exaggeration.value = String(initial.exaggeration);
  exaggerationOut.textContent = `${initial.exaggeration}×`;
  azimuth.value = String(initial.sunAzimuth);
  azimuthOut.textContent = `${initial.sunAzimuth}°`;
  altitude.value = String(initial.sunAltitude);
  altitudeOut.textContent = `${initial.sunAltitude}°`;

  const contourInput = form.querySelector<HTMLInputElement>(
    `input[name="contour"][value="${initial.contourInterval}"]`,
  );
  if (contourInput) {
    contourInput.checked = true;
  }
  for (const [name, on] of [
    ['currents', initial.currents],
    ['buoys', initial.buoys],
    ['aircraft', initial.aircraft],
  ] as const) {
    const box = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (box) {
      box.checked = on;
    }
  }
  const unitsInput = form.querySelector<HTMLInputElement>(
    `input[name="units"][value="${initial.units}"]`,
  );
  if (unitsInput) {
    unitsInput.checked = true;
  }

  const read = (): ViewerControls => {
    const checked = form.querySelector<HTMLInputElement>('input[name="contour"]:checked');
    const on = (name: string): boolean =>
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked === true;
    const unitChoice = form.querySelector<HTMLInputElement>('input[name="units"]:checked');
    return {
      exaggeration: Number(exaggeration.value),
      contourInterval: Number(checked?.value ?? 0),
      sunAzimuth: Number(azimuth.value),
      sunAltitude: Number(altitude.value),
      currents: on('currents'),
      buoys: on('buoys'),
      aircraft: on('aircraft'),
      units: isDepthUnit(unitChoice?.value) ? unitChoice.value : 'm',
    };
  };

  const emit = (): void => {
    const state = read();
    exaggerationOut.textContent = `${state.exaggeration}×`;
    azimuthOut.textContent = `${state.sunAzimuth}°`;
    altitudeOut.textContent = `${state.sunAltitude}°`;
    onChange(state);
  };

  form.addEventListener('input', emit);
  form.addEventListener('change', emit);

  return {
    get: read,
    setExaggeration(value: number): void {
      exaggeration.value = String(value);
      exaggerationOut.textContent = `${value}×`;
    },
  };
}

export function mountNavHelp(root: HTMLElement, toggle: HTMLButtonElement): void {
  const setOpen = (open: boolean): void => {
    root.classList.toggle('is-open', open);
    if (open) {
      root.classList.remove('is-dismissed');
    }
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!root.classList.contains('is-open'));
  });

  toggle.addEventListener('blur', () => {
    root.classList.remove('is-dismissed');
  });

  root.addEventListener('mouseenter', () => {
    root.classList.remove('is-dismissed');
  });

  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target as Node)) {
      setOpen(false);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (!root.classList.contains('is-open') && document.activeElement !== toggle) {
      return;
    }
    event.preventDefault();
    setOpen(false);
    root.classList.add('is-dismissed');
  });
}

export function mountAbout(dialog: HTMLDialogElement, toggle: HTMLButtonElement): void {
  const close = (): void => {
    if (dialog.open) {
      dialog.close();
    }
  };

  const open = (): void => {
    if (!dialog.open) {
      dialog.showModal();
    }
  };

  toggle.addEventListener('click', () => {
    if (dialog.open) {
      close();
    } else {
      open();
    }
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return;
    }
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      event.preventDefault();
      if (dialog.open) {
        close();
      } else {
        open();
      }
    }
  });
}

/**
 * Buoy and aircraft detail now render as their own block inside the
 * inspector card rather than replacing the position and depth rows, so
 * hovering a station no longer costs the reader the depth under it. These
 * three wrappers stay as the overlays' entry points; the panel itself lives
 * in ui/inspector.ts.
 */
export function setBuoyReadout(el: HTMLElement, detail: DetailBlock | null): void {
  if (detail != null) {
    el.dataset.buoy = '1';
    delete el.dataset.aircraft;
    setDetail(el, detail);
    return;
  }
  delete el.dataset.buoy;
  // Only clear the block if an aircraft has not meanwhile claimed it.
  if (el.dataset.aircraft !== '1') {
    setDetail(el, null);
  }
}

export function setAircraftReadout(el: HTMLElement, detail: DetailBlock | null): void {
  if (detail != null) {
    el.dataset.aircraft = '1';
    delete el.dataset.buoy;
    setDetail(el, detail);
    return;
  }
  delete el.dataset.aircraft;
  if (el.dataset.buoy !== '1') {
    setDetail(el, null);
  }
}

let pendingClear = 0;

/**
 * The position rows track the pointer continuously, with one exception.
 *
 * Sliding the cursor from the terrain onto a station glyph fires the canvas's
 * pointerleave *before* the mark's pointerenter, so a synchronous clear would
 * blank the depth at the exact spot the reader is asking about — and testing
 * the engaged flag inline does not help, because nothing has set it yet at
 * that point. Deferring one frame lets the mark claim the card first; if it
 * does, the clear is dropped and the depth beside the station stays readable,
 * which is the whole reason the two now live in one card.
 */
export function setReadout(el: HTMLElement, sample: ElevationSample | null): void {
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  if (sample == null) {
    if (!raf) {
      setPosition(el, null);
      return;
    }
    if (pendingClear) {
      cancelAnimationFrame(pendingClear);
    }
    pendingClear = raf(() => {
      pendingClear = 0;
      if (el.dataset.buoy === '1' || el.dataset.aircraft === '1') {
        return;
      }
      setPosition(el, null);
    });
    return;
  }
  if (pendingClear && raf) {
    cancelAnimationFrame(pendingClear);
    pendingClear = 0;
  }
  setPosition(el, sample);
}

export function setStatus(el: HTMLElement, message: string | null, warn = false): void {
  el.hidden = !message;
  el.textContent = message ?? '';
  el.classList.toggle('is-warn', warn);
}

/**
 * The controls disclosure, for narrow viewports.
 *
 * Only meaningful below the CSS breakpoint that hides the button: above it
 * the panel is always open and this is inert. The collapsed state is applied
 * to the block, not the form, because the CSS that hides the controls is
 * scoped to the breakpoint — so widening the window reveals them again
 * without the reader having to find the button.
 *
 * `narrow` is injected rather than read from `window` here so the behaviour
 * is testable without a DOM matchMedia.
 */
export function mountBlockToggle(
  block: HTMLElement,
  toggle: HTMLButtonElement,
  narrow: () => boolean,
): void {
  const apply = (collapsed: boolean): void => {
    block.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };

  // Start collapsed on a phone-sized viewport and open everywhere else.
  apply(narrow());

  toggle.addEventListener('click', () => {
    apply(!block.classList.contains('is-collapsed'));
  });
}
