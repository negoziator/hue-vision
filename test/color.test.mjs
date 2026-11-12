import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToXy, sampleFrame, hexToRgb, rgbToHex } from '../public/color.js';

test('primaries land in the right corners of the CIE diagram', () => {
    const [rx, ry] = rgbToXy(255, 0, 0);
    const [gx, gy] = rgbToXy(0, 255, 0);
    const [bx, by] = rgbToXy(0, 0, 255);
    assert.ok(rx > 0.6 && ry < 0.35, `red ${rx},${ry}`);
    assert.ok(gy > 0.6, `green ${gx},${gy}`);
    assert.ok(bx < 0.2 && by < 0.1, `blue ${bx},${by}`);
});

test('black does not divide by zero', () => {
    assert.deepEqual(rgbToXy(0, 0, 0), [0.3227, 0.329]);
});

test('vivid mode picks the saturated colour out of a grey frame', () => {
    const pixels = [];
    for (let i = 0; i < 100; i++) {
        pixels.push(...(i < 15 ? [230, 20, 20, 255] : [128, 128, 128, 255]));
    }
    const vivid = sampleFrame(new Uint8ClampedArray(pixels), 'vivid');
    const average = sampleFrame(new Uint8ClampedArray(pixels), 'average');

    assert.ok(vivid.rgb[0] > 200 && vivid.rgb[1] < 40, `vivid ${vivid.rgb}`);
    assert.ok(Math.abs(average.rgb[0] - average.rgb[1]) < 120, `average ${average.rgb}`);
    assert.equal(vivid.brightness, average.brightness);
});

test('greyscale frames fall back to the average', () => {
    const pixels = new Uint8ClampedArray(Array(400).fill(200));
    assert.deepEqual(sampleFrame(pixels, 'vivid').rgb, [200, 200, 200]);
});

test('hex round-trips', () => {
    assert.equal(rgbToHex(hexToRgb('#7c5cff')), '#7c5cff');
});
