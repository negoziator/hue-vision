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
 * Brightness always tracks the sampled area, so dark scenes dim the lights.
 *
 * `weights` (one per pixel, see regionWeights) focuses the sample on part of the frame;
 * null samples the whole frame evenly.
 */
export function sampleFrame(data, mode = 'vivid', weights = null) {
    let sumR = 0, sumG = 0, sumB = 0, sumValue = 0, sumWeight = 0;
    let wR = 0, wG = 0, wB = 0, wTotal = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const w = weights ? weights[p] : 1;
        if (w < 0.001) {
            continue;
        }

        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const value = max / 255;

        sumR += r * w; sumG += g * w; sumB += b * w; sumValue += value * w; sumWeight += w;

        if (value < 0.08) {
            continue;
        }

        const saturation = (max - min) / max;
        const weight = saturation * saturation * value * w;
        wR += r * weight; wG += g * weight; wB += b * weight; wTotal += weight;
    }

    if (sumWeight === 0) {
        return { rgb: [0, 0, 0], brightness: 0 };
    }

    const average = [sumR / sumWeight, sumG / sumWeight, sumB / sumWeight];
    const brightness = sumValue / sumWeight;

    if (mode !== 'vivid' || wTotal < sumWeight * 0.01) {
        return { rgb: average, brightness };
    }

    return { rgb: [wR / wTotal, wG / wTotal, wB / wTotal], brightness };
}

/**
 * Per-pixel weights for a light placed at `position` relative to the screen:
 * (0,0) is the screen's top-left corner, (1,1) its bottom-right, and values outside 0..1 sit beside it.
 *
 * The light watches the nearest point of the screen; the further away it stands,
 * the wider the area it blends. Returns null (whole screen) for a light that isn't placed.
 */
export function regionWeights(position, width, height) {
    if (!position) {
        return null;
    }

    const focusX = clamp(position.x, 0, 1);
    const focusY = clamp(position.y, 0, 1);
    const distance = Math.hypot(position.x - focusX, position.y - focusY);
    const spread = 0.2 + distance * 0.8;
    const weights = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = (x + 0.5) / width - focusX;
            const dy = (y + 0.5) / height - focusY;
            weights[y * width + x] = Math.exp(-(dx * dx + dy * dy) / (2 * spread * spread));
        }
    }

    return weights;
}

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}
