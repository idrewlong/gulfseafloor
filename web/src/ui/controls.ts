export type ViewerControls = {
  exaggeration: number;
  contourInterval: number;
  sunAzimuth: number;
  sunAltitude: number;
  imageryOpacity: number;
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

export function formatLat(lat: number): string {
  const hemi = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(4)}°${hemi}`;
}

export function formatLon(lon: number): string {
  const hemi = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lon).toFixed(4)}°${hemi}`;
}

export function formatElevation(metres: number): string {
  const sign = metres > 0 ? '+' : metres < 0 ? '−' : '';
  return `${sign}${Math.abs(metres).toFixed(1)} m`;
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
  const imagery = form.querySelector<HTMLFieldSetElement>('#imagery');

  if (!exaggeration || !exaggerationOut || !contour || !azimuth || !azimuthOut || !altitude || !altitudeOut || !imagery) {
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
  const imageryInput = form.querySelector<HTMLInputElement>(
    `input[name="imagery"][value="${initial.imageryOpacity}"]`,
  );
  if (imageryInput) {
    imageryInput.checked = true;
  }

  const read = (): ViewerControls => {
    const checked = form.querySelector<HTMLInputElement>('input[name="contour"]:checked');
    const img = form.querySelector<HTMLInputElement>('input[name="imagery"]:checked');
    return {
      exaggeration: Number(exaggeration.value),
      contourInterval: Number(checked?.value ?? 0),
      sunAzimuth: Number(azimuth.value),
      sunAltitude: Number(altitude.value),
      imageryOpacity: Number(img?.value ?? 0),
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

export function setReadout(
  el: HTMLElement,
  sample: { lon: number; lat: number; elevation: number | null } | null,
): void {
  const llEl = el.querySelector('.readout-ll');
  const depthEl = el.querySelector('.readout-depth');
  const ll = sample ? `${formatLat(sample.lat)} ${formatLon(sample.lon)}` : '—';
  const depth = sample == null || sample.elevation === null ? '—' : formatElevation(sample.elevation);
  if (llEl && llEl.textContent !== ll) {
    llEl.textContent = ll;
  }
  if (depthEl && depthEl.textContent !== depth) {
    depthEl.textContent = depth;
  }
}

export function setStatus(el: HTMLElement, message: string | null, warn = false): void {
  el.hidden = !message;
  el.textContent = message ?? '';
  el.classList.toggle('is-warn', warn);
}
