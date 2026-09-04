import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GLYPH_RADIUS, kindLabel, stationGlyphSvg, stationKind } from './stationGlyph.ts';
import { markSvgMarkup, type BuoyStation } from './buoys.ts';

describe('stationKind', () => {
  it('accepts the classes NDBC actually publishes', () => {
    assert.equal(stationKind('buoy'), 'buoy');
    assert.equal(stationKind('fixed'), 'fixed');
    assert.equal(stationKind('rig'), 'rig');
    assert.equal(stationKind('dart'), 'dart');
  });

  it('falls back to other for absent or unrecognized classes', () => {
    // A snapshot written before the server sent `kind` at all.
    assert.equal(stationKind(undefined), 'other');
    assert.equal(stationKind(null), 'other');
    // NDBC adds platform types without notice; an unknown one is still a
    // real station and must still get a glyph.
    assert.equal(stationKind('saildrone'), 'other');
    assert.equal(stationKind(42), 'other');
  });
});

describe('stationGlyphSvg', () => {
  it('draws a moored buoy and a fixed station as different shapes', () => {
    // The whole point of the glyph: a discus buoy on the shelf and an
    // anemometer bolted to a pier report the same fields, and must not be
    // drawn the same way.
    const buoy = stationGlyphSvg('buoy');
    const fixed = stationGlyphSvg('fixed');
    assert.match(buoy, /<circle/);
    assert.match(fixed, /<rect/);
    assert.notEqual(buoy, fixed);
  });

  it('leaves floating platforms hollow and anchored ones filled', () => {
    assert.match(stationGlyphSvg('buoy'), /fill="none"/);
    assert.match(stationGlyphSvg('dart'), /fill="none"/);
    assert.match(stationGlyphSvg('fixed'), /fill="currentColor"/);
    assert.match(stationGlyphSvg('rig'), /fill="currentColor"/);
  });

  it('gives every kind a distinct glyph', () => {
    const kinds = ['buoy', 'fixed', 'rig', 'dart', 'other'] as const;
    const drawn = kinds.map((k) => stationGlyphSvg(k));
    assert.equal(new Set(drawn).size, kinds.length);
  });

  it('centres every glyph horizontally on the station position', () => {
    // The mark is translated so the viewBox centre (20,20) lands on the
    // projected lon/lat. A glyph drawn off-centre would point at the wrong
    // water, so check the actual geometry rather than the presence of "20".
    for (const kind of ['buoy', 'fixed', 'rig', 'dart', 'other'] as const) {
      const svg = stationGlyphSvg(kind);
      const circle = /cx="([\d.]+)"/.exec(svg);
      const rect = /x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(svg);
      if (circle) {
        assert.equal(Number(circle[1]), 20, kind);
        continue;
      }
      if (rect) {
        assert.equal(Number(rect[1]) + Number(rect[2]) / 2, 20, kind);
        continue;
      }
      const xs = [...svg.matchAll(/[ML] ([\d.]+) [\d.]+/g)].map((m) => Number(m[1]));
      assert.ok(xs.length > 0, `no geometry in ${svg}`);
      assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 20, kind);
    }
  });

  it('emits clean numbers, not float noise', () => {
    for (const kind of ['buoy', 'fixed', 'rig', 'dart', 'other'] as const) {
      assert.doesNotMatch(stationGlyphSvg(kind), /\d\.\d{4,}/, kind);
    }
  });
});

describe('kindLabel', () => {
  it('names the platform in words for the readout', () => {
    assert.equal(kindLabel('buoy'), 'Moored buoy');
    assert.equal(kindLabel('fixed'), 'Fixed station');
    assert.equal(kindLabel('rig'), 'Platform');
    assert.equal(kindLabel('other'), 'Station');
  });
});

describe('markSvgMarkup', () => {
  const at = (over: Partial<BuoyStation>): BuoyStation => ({
    id: 'X',
    lon: -89,
    lat: 30.2,
    ...over,
  });

  it('draws the glyph even when the station reported no wind', () => {
    // A station with no anemometer still has a position worth marking, and
    // before the glyph existed it rendered as nothing at all.
    const markup = markSvgMarkup(at({ kind: 'fixed' }));
    assert.match(markup, /<rect/);
    assert.doesNotMatch(markup, /<path/);
  });

  it('adds the barb when wind is reported', () => {
    const markup = markSvgMarkup(at({ kind: 'buoy', wdir: 180, wspd: 6.2 }));
    assert.match(markup, /<circle/);
    assert.match(markup, /<path/);
  });

  it('holds the staff clear of the glyph', () => {
    // Wind from due north puts the staff straight up from centre (20,20).
    // Its foot must start at the glyph edge, not inside it, or the staff
    // strikes through the platform mark and the two read as one blob.
    const markup = markSvgMarkup(at({ kind: 'buoy', wdir: 0, wspd: 10 }));
    const foot = /M 20\.00 (\d+\.\d+) L/.exec(markup);
    assert.ok(foot, `no staff foot in ${markup}`);
    assert.ok(
      Math.abs(Number(foot[1]) - (20 - GLYPH_RADIUS)) < 0.01,
      `staff foot at ${foot[1]}, want ${20 - GLYPH_RADIUS}`,
    );
  });

  it('encircles the glyph for calm rather than covering it', () => {
    const markup = markSvgMarkup(at({ kind: 'buoy', wdir: 0, wspd: 0 }));
    const radii = [...markup.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.equal(radii.length, 2, `want glyph + calm ring, got ${markup}`);
    // The calm ring sits outside the glyph it annotates.
    assert.ok(Math.max(...radii) > Math.min(...radii));
  });
});
