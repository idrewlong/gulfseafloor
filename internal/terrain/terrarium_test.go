package terrain

import (
	"image"
	"image/color"
	"math"
	"testing"
)

func TestRoundTripKnownDepths(t *testing.T) {
	cases := []float64{
		-10000,
		-3500, // Sigsbee Deep, rounded
		-100,
		-10.1,
		-0.1,
		0,
		1.5,
		15,
		100,
		6777.2,
	}
	for _, want := range cases {
		r, g, b := Encode(want)
		got := Decode(r, g, b)
		if math.Abs(got-want) > IntervalMetres/2+1e-9 {
			t.Errorf("round-trip %g m: encode(%g) = (%d,%d,%d) decode = %g", want, want, r, g, b, got)
		}
	}
}

func TestDecodeSpecFormula(t *testing.T) {
	// A pixel that should decode to exactly 0 m:
	// 0 = -10000 + ((R*65536 + G*256 + B) * 0.1)  =>  packed = 100000
	r, g, b := Encode(0)
	if got := Decode(r, g, b); math.Abs(got) > IntervalMetres/2 {
		t.Fatalf("sea level: got %g, want ~0 (rgb=%d,%d,%d)", got, r, g, b)
	}
}

func TestEncodeClamps(t *testing.T) {
	r, g, b := Encode(-20000)
	if r != 0 || g != 0 || b != 0 {
		t.Errorf("below-min encode: got %d,%d,%d want 0,0,0", r, g, b)
	}
	r, g, b = Encode(1e9)
	if Decode(r, g, b) < MaxMetres-1 {
		t.Errorf("above-max encode did not saturate: %d,%d,%d -> %g", r, g, b, Decode(r, g, b))
	}
}

func TestDecodeAtBounds(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.SetNRGBA(0, 0, EncodeNRGBA(-42.3))
	got, err := DecodeAt(img, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(got-(-42.3)) > IntervalMetres {
		t.Errorf("DecodeAt: got %g want ~-42.3", got)
	}
	if _, err := DecodeAt(img, 5, 5); err == nil {
		t.Fatal("expected out-of-bounds error")
	}
}

func TestDecodeColorIgnoresAlpha(t *testing.T) {
	r, g, b := Encode(-12.5)
	c := color.NRGBA{R: r, G: g, B: b, A: 1}
	if math.Abs(DecodeColor(c)-(-12.5)) > IntervalMetres {
		t.Fatalf("alpha leaked into decode: %g", DecodeColor(c))
	}
}
