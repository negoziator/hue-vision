/**
 * sRGB (0-255) -> CIE xy, the colour space the Hue API speaks.
 * The bridge clamps out-of-gamut points to each bulb's own gamut.
 */
export function rgbToXy(r, g, b) {
    const linear = (c) => {
        c /= 255;
        return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
    };
    const R = linear(r);
    const G = linear(g);
    const B = linear(b);

    const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
    const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
    const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
    const sum = X + Y + Z;

    if (sum === 0) {
        return [0.3227, 0.329];
    }

    return [round4(X / sum), round4(Y / sum)];
}

export function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** Approximate xy + brightness back to a displayable hex, for showing a light's current colour. */
export function xyToHex([x, y], bri = 254) {
    const z = 1 - x - y;
    const Y = 1;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

    const max = Math.max(r, g, b, 1e-6);
    [r, g, b] = [r, g, b].map((c) => Math.max(0, c / max));

    const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const scale = 0.35 + 0.65 * (bri / 254);

    return rgbToHex([r, g, b].map((c) => gamma(c) * 255 * scale));
}

/**
 * Reduce a frame of RGBA pixels to one colour + one brightness.
 *
 * "vivid" weights saturated, lit pixels so a bright red logo on a grey UI still reads as red;
 * it falls back to the plain average when the scene is essentially greyscale.
 * Brightness always tracks the whole scene, so dark scenes dim the lights.
 */
export function sampleFrame(data, mode = 'vivid') {
    let sumR = 0, sumG = 0, sumB = 0, sumValue = 0;
    let wR = 0, wG = 0, wB = 0, wTotal = 0;
    const pixels = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const value = max / 255;

        sumR += r; sumG += g; sumB += b; sumValue += value;

        if (value < 0.08) {
            continue;
        }

        const saturation = (max - min) / max;
        const weight = saturation * saturation * value;
        wR += r * weight; wG += g * weight; wB += b * weight; wTotal += weight;
    }

    const average = [sumR / pixels, sumG / pixels, sumB / pixels];
    const brightness = sumValue / pixels;

    if (mode !== 'vivid' || wTotal < pixels * 0.01) {
        return { rgb: average, brightness };
    }

    return { rgb: [wR / wTotal, wG / wTotal, wB / wTotal], brightness };
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}
