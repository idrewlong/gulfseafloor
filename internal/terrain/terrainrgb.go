// Package terrain implements Mapbox terrain-RGB elevation encoding.
//
//	elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
//
// That packing yields 0.1 m resolution from −10 000 m to +6 777.215 m, and is
// what `rio rgbify -b -10000 -i 0.1` writes.
//
// This is deliberately NOT Mapzen Terrarium, whose formula is
// (R*256 + G + B/256) - 32768. The two are not interchangeable: decoding a
// real Terrarium tile with Decode below returns roughly 828 000 m. The build
// spec calls the scheme "Terrarium"; the numbers have always been Mapbox's.
// See docs/architecture.md §2 and docs/adr/0001.
package terrain

import (
	"fmt"
	"image"
	"image/color"
	"math"
)

const (
	// OffsetMetres is subtracted after decoding (and added before encoding).
	OffsetMetres = 10000.0
	// IntervalMetres is the quantisation step.
	IntervalMetres = 0.1
	// MinMetres is the most negative elevation the scheme can represent.
	MinMetres = -OffsetMetres
	// MaxMetres is the most positive elevation the scheme can represent
	// with 24-bit storage: -10000 + (16777215 * 0.1).
	MaxMetres = -OffsetMetres + 16777215*IntervalMetres
)

// Decode returns elevation in metres from an 8-bit terrain-RGB triple.
func Decode(r, g, b uint8) float64 {
	return -OffsetMetres + (float64(uint32(r)*65536+uint32(g)*256+uint32(b)) * IntervalMetres)
}

// DecodeColor is Decode for a color.Color, ignoring alpha.
// NRGBA / RGBA are read without premultiplication so a low alpha cannot
// collapse the packed elevation to the nodata floor.
func DecodeColor(c color.Color) float64 {
	switch n := c.(type) {
	case color.NRGBA:
		return Decode(n.R, n.G, n.B)
	case color.RGBA:
		return Decode(n.R, n.G, n.B)
	case color.NRGBA64:
		return Decode(uint8(n.R>>8), uint8(n.G>>8), uint8(n.B>>8))
	default:
		r, g, b, _ := c.RGBA()
		return Decode(uint8(r>>8), uint8(g>>8), uint8(b>>8))
	}
}

// Encode packs elevation (metres) into a terrain-RGB triple.
// Values outside the representable range are clamped.
func Encode(elevationMetres float64) (r, g, b uint8) {
	clamped := math.Min(MaxMetres, math.Max(MinMetres, elevationMetres))
	scaled := math.Round((clamped + OffsetMetres) / IntervalMetres)
	if scaled < 0 {
		scaled = 0
	}
	if scaled > 16777215 {
		scaled = 16777215
	}
	v := uint32(scaled)
	return uint8(v >> 16), uint8((v >> 8) & 0xFF), uint8(v & 0xFF)
}

// EncodeNRGBA is Encode as an opaque NRGBA pixel.
func EncodeNRGBA(elevationMetres float64) color.NRGBA {
	r, g, b := Encode(elevationMetres)
	return color.NRGBA{R: r, G: g, B: b, A: 255}
}

// DecodeAt samples one pixel of a terrain-RGB-encoded image.
func DecodeAt(img image.Image, x, y int) (float64, error) {
	b := img.Bounds()
	if x < b.Min.X || x >= b.Max.X || y < b.Min.Y || y >= b.Max.Y {
		return 0, fmt.Errorf("terrain: pixel (%d,%d) outside bounds %v", x, y, b)
	}
	return DecodeColor(img.At(x, y)), nil
}
