import { rgbToXy, hexToRgb, rgbToHex, xyToHex, sampleFrame, regionWeights } from './color.js';

const $ = (id) => document.getElementById(id);
const FOLLOW_KEY = 'hue-vision:follow';
const PLACEMENT_KEY = 'hue-vision:placement';

const state = {
    lights: [],
    following: new Set(loadJson(FOLLOW_KEY, [])),
    /** light id -> { x, y } relative to the screen (0..1 = on the screen, outside = beside it). */
    placement: loadJson(PLACEMENT_KEY, {}),
    /** light id -> pin dot on the placement map. */
    dots: new Map(),
    /** light id -> colour the light is showing while "What you see" runs. */
    liveHex: new Map(),
    vision: null,
};

/* ---------------- API ---------------- */

async function api(method, url, body) {
    const response = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

/* ---------------- Bridge ---------------- */

function setStatus(text, kind) {
    const pill = $('status');
    pill.textContent = text;
    pill.className = `pill ${kind ?? ''}`;
}

function showBridgeStep(step) {
    for (const id of ['bridge-choose', 'bridge-pair', 'bridge-ok']) {
        $(id).classList.toggle('hidden', id !== step);
    }
    const connected = step === 'bridge-ok';
    $('lights-section').classList.toggle('hidden', !connected);
    $('vision-section').classList.toggle('hidden', !connected);
}

async function refreshStatus() {
    $('bridge-error').textContent = '';
    const status = await api('GET', '/api/status');

    if (!status.bridgeIp) {
        setStatus('No bridge', 'warn');
        showBridgeStep('bridge-choose');
        return;
    }
    if (!status.reachable) {
        setStatus('Bridge unreachable', 'bad');
        $('bridge-error').textContent = `Can't reach the bridge at ${status.bridgeIp}. Same network?`;
        showBridgeStep('bridge-choose');
        return;
    }
    if (!status.paired) {
        setStatus('Not paired', 'warn');
        $('pair-name').textContent = `${status.bridgeName} (${status.bridgeIp})`;
        showBridgeStep('bridge-pair');
        return;
    }

    setStatus('Connected', 'ok');
    $('ok-name').textContent = status.bridgeName;
    $('ok-ip').textContent = status.bridgeIp;
    showBridgeStep('bridge-ok');
    await loadLights();
}

$('discover').onclick = async () => {
    const list = $('discovered');
    list.innerHTML = '<span class="muted">Searching…</span>';
    const bridges = await api('GET', '/api/discover').catch(() => []);
    list.innerHTML = bridges.length ? '' : '<span class="muted">No bridges found. Enter the IP manually (see the Hue app → Settings → Bridges).</span>';

    for (const bridge of bridges) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<button class="primary">Use</button><span><strong></strong> <span class="muted"></span></span>`;
        row.querySelector('strong').textContent = bridge.name;
        row.querySelector('.muted').textContent = bridge.ip + (bridge.reachable ? '' : ' (unreachable)');
        row.querySelector('button').onclick = () => chooseBridge(bridge.ip);
        list.append(row);
    }
};

$('use-ip').onclick = () => chooseBridge($('manual-ip').value.trim());

async function chooseBridge(ip) {
    try {
        await api('POST', '/api/bridge', { ip });
        await refreshStatus();
    } catch (error) {
        $('bridge-error').textContent = error.message;
    }
}

$('pair').onclick = async () => {
    const button = $('pair');
    button.disabled = true;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        try {
            await api('POST', '/api/pair');
            button.disabled = false;
            return refreshStatus();
        } catch (error) {
            if (error.status !== 428) {
                $('bridge-error').textContent = error.message;
                break;
            }
            const left = Math.ceil((deadline - Date.now()) / 1000);
            button.textContent = `Waiting for link button… ${left}s`;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    button.disabled = false;
    button.textContent = 'Pair';
    if (!$('bridge-error').textContent) {
        $('bridge-error').textContent = 'Timed out. Press the link button and try again.';
    }
};

$('change-bridge').onclick = () => showBridgeStep('bridge-choose');

$('unpair').onclick = async () => {
    await stopVision();
    await api('POST', '/api/unpair');
    await refreshStatus();
};

/* ---------------- Lights ---------------- */

async function loadLights() {
    try {
        state.lights = await api('GET', '/api/lights');
        renderLights();
    } catch (error) {
        if (error.status === 401) {
            return refreshStatus();
        }
        $('bridge-error').textContent = error.message;
    }
}

function lightHex(light) {
    if (light.xy) {
        return xyToHex(light.xy, light.bri ?? 254);
    }
    return '#ffd9a0';
}

function renderLights() {
    const container = $('lights');
    container.innerHTML = '';

    for (const light of state.lights) {
        const card = document.createElement('div');
        card.className = `light ${light.on ? '' : 'off'} ${light.reachable ? '' : 'unreachable'}`;
        card.innerHTML = `
            <div class="top">
                <div class="bulb"></div>
                <div class="name"></div>
                <label class="switch"><input type="checkbox"><span></span></label>
            </div>
            <div class="row" style="flex-wrap: nowrap">
                <input type="range" min="1" max="254" class="bri">
                <input type="color" class="color">
            </div>
            <label class="check"><input type="checkbox" class="follow"> Follow screen</label>
        `;

        const bulb = card.querySelector('.bulb');
        const name = card.querySelector('.name');
        const toggle = card.querySelector('.switch input');
        const bri = card.querySelector('.bri');
        const color = card.querySelector('.color');
        const follow = card.querySelector('.follow');

        name.textContent = light.name;
        name.title = `${light.name} · ${light.type}${light.reachable ? '' : ' · unreachable'}`;
        bulb.style.color = lightHex(light);
        toggle.checked = light.on;
        bri.value = light.bri ?? 254;
        bri.disabled = !light.supportsDimming;
        color.value = lightHex(light);
        color.classList.toggle('hidden', !light.supportsColor);
        follow.checked = state.following.has(light.id);

        toggle.onchange = async () => {
            light.on = toggle.checked;
            card.classList.toggle('off', !light.on);
            await setLight(light.id, { on: light.on });
        };

        bri.oninput = throttle(() => {
            light.bri = Number(bri.value);
            setLight(light.id, { on: true, bri: light.bri, transitiontime: 1 });
        }, 120);

        color.oninput = throttle(() => {
            bulb.style.color = color.value;
            setLight(light.id, { on: true, xy: rgbToXy(...hexToRgb(color.value)), transitiontime: 1 });
        }, 120);

        follow.onchange = () => {
            follow.checked ? state.following.add(light.id) : state.following.delete(light.id);
            saveJson(FOLLOW_KEY, [...state.following]);
            renderPlacement();
        };

        light.bulbElement = bulb;
        container.append(card);
    }

    renderPlacement();
}

/* ---------------- Placement ----------------
 * The map is the screen with a margin around it. Followed lights are pins: drop one
 * beside the screen and it follows that part of the picture; pins left in the tray
 * follow the whole screen.
 */

/** Where the screen sits inside the map, as a fraction of the map on each side (matches `.screen { inset }`). */
const SCREEN_INSET = 0.16;
const SCREEN_SIZE = 1 - 2 * SCREEN_INSET;

function renderPlacement() {
    const stageLights = $('stage-lights');
    const tray = $('tray');
    stageLights.innerHTML = '';
    tray.innerHTML = '';
    state.dots.clear();

    const followed = state.lights.filter((l) => state.following.has(l.id));
    if (followed.length === 0) {
        tray.innerHTML = '<span class="muted">Tick “Follow screen” on a light to place it here.</span>';
    }

    for (const light of followed) {
        const position = state.placement[light.id];
        const pin = document.createElement('div');
        pin.className = 'pin';
        pin.innerHTML = '<div class="dot"></div><div class="pin-label"></div>';
        pin.querySelector('.pin-label').textContent = light.name;
        pin.title = position
            ? `${light.name}: follows the nearest part of the screen. Drag back to the tray to follow the whole screen.`
            : `${light.name}: follows the whole screen. Drag it onto the map to place it.`;

        const dot = pin.querySelector('.dot');
        dot.style.color = state.liveHex.get(light.id) ?? lightHex(light);
        state.dots.set(light.id, dot);
        pin.onpointerdown = (event) => dragPin(event, pin, light);

        if (position) {
            pin.style.left = `${(SCREEN_INSET + position.x * SCREEN_SIZE) * 100}%`;
            pin.style.top = `${(SCREEN_INSET + position.y * SCREEN_SIZE) * 100}%`;
            stageLights.append(pin);
        } else {
            tray.append(pin);
        }
    }
}

function dragPin(event, pin, light) {
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();

    // Keep the dot where it was grabbed instead of snapping its centre to the pointer.
    const dotRect = pin.querySelector('.dot').getBoundingClientRect();
    const offsetX = event.clientX - (dotRect.left + dotRect.width / 2);
    const offsetY = event.clientY - (dotRect.top + dotRect.height / 2);
    const move = (e) => {
        pin.style.left = `${e.clientX - offsetX}px`;
        pin.style.top = `${e.clientY - offsetY}px`;
    };

    pin.setPointerCapture(event.pointerId);
    pin.classList.add('dragging');
    move(event);
    pin.onpointermove = move;

    pin.onpointerup = pin.onpointercancel = (e) => {
        pin.onpointermove = pin.onpointerup = pin.onpointercancel = null;

        if (e.type === 'pointerup') {
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;
            const stage = $('stage').getBoundingClientRect();
            const onStage = x >= stage.left && x <= stage.right && y >= stage.top && y <= stage.bottom;

            if (onStage) {
                state.placement[light.id] = {
                    x: round3(((x - stage.left) / stage.width - SCREEN_INSET) / SCREEN_SIZE),
                    y: round3(((y - stage.top) / stage.height - SCREEN_INSET) / SCREEN_SIZE),
                };
            } else {
                delete state.placement[light.id];
            }
            saveJson(PLACEMENT_KEY, state.placement);
            weightCache.clear();
        }

        renderPlacement();
    };
}

/** Sampling weights per placement, rebuilt only when a light is moved. */
const weightCache = new Map();

function weightsFor(id) {
    const position = state.placement[id];
    const key = position ? `${position.x},${position.y}` : 'screen';
    if (!weightCache.has(key)) {
        weightCache.set(key, regionWeights(position, SAMPLE_WIDTH, SAMPLE_HEIGHT));
    }
    return [key, weightCache.get(key)];
}

async function setLight(id, body) {
    try {
        await api('PUT', `/api/lights/${id}`, body);
    } catch (error) {
        $('bridge-error').textContent = error.message;
    }
}

$('all-on').onclick = async () => { await api('PUT', '/api/all', { on: true }); await loadLights(); };
$('all-off').onclick = async () => { await stopVision(); await api('PUT', '/api/all', { on: false }); await loadLights(); };
$('refresh').onclick = loadLights;

/* ---------------- What you see ---------------- */

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const TICKS_PER_SECOND = 12;

/**
 * Timers in a Web Worker are not throttled like main-thread timers when this tab is
 * in the background - which is exactly where it will be while you watch the screen.
 */
function createTicker(hz) {
    const source = `setInterval(() => postMessage(0), ${Math.round(1000 / hz)});`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    return worker;
}

$('vision-start').onclick = startVision;
$('vision-stop').onclick = stopVision;

for (const [input, label, format] of [
    ['boost', 'boost-value', (v) => `${Math.round(v * 100)}%`],
    ['minbri', 'minbri-value', (v) => v],
    ['smooth', 'smooth-value', (v) => `${Math.round(v * 100)}%`],
]) {
    const update = () => ($(label).textContent = format(Number($(input).value)));
    $(input).addEventListener('input', update);
    update();
}

async function startVision() {
    $('vision-error').textContent = '';
    const targets = state.lights.filter((l) => state.following.has(l.id) && l.reachable);

    if (targets.length === 0) {
        $('vision-error').textContent = 'Tick “Follow screen” on at least one reachable light first.';
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch {
        $('vision-error').textContent = 'Screen sharing was cancelled or blocked.';
        return;
    }

    const video = $('preview');
    video.srcObject = stream;
    await video.play();

    const canvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const ticker = createTicker(TICKS_PER_SECOND);
    const snapshot = state.lights.filter((l) => targets.includes(l)).map((l) => ({ ...l }));

    await Promise.all(targets.filter((l) => !l.on).map((l) => setLight(l.id, { on: true })));

    /** Smoothed sample per light id, plus 'screen' for the whole-screen swatch. */
    const smoothed = new Map();
    let sending = false;

    ticker.onmessage = async () => {
        if (video.readyState < 2) {
            return;
        }

        context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        const mode = $('mode').value;
        const keep = Number($('smooth').value);
        const minBri = Number($('minbri').value);
        const boost = Number($('boost').value);

        // Lights placed at the same spot (or all unplaced lights) share one sample.
        const samples = new Map();
        const sampleArea = (key, weights) => {
            if (!samples.has(key)) {
                samples.set(key, sampleFrame(data, mode, weights));
            }
            return samples.get(key);
        };
        const smooth = (id, sample) => {
            const previous = smoothed.get(id);
            const next = previous
                ? { rgb: previous.rgb.map((c, i) => c * keep + sample.rgb[i] * (1 - keep)), brightness: previous.brightness * keep + sample.brightness * (1 - keep) }
                : sample;
            smoothed.set(id, next);
            return next;
        };

        const screenHex = rgbToHex(smooth('screen', sampleArea('screen', null)).rgb);
        $('swatch').style.background = screenHex;
        $('swatch').style.color = screenHex;
        document.documentElement.style.setProperty('--glow', screenHex);

        const payload = {};
        for (const light of targets) {
            const sample = smooth(light.id, sampleArea(...weightsFor(light.id)));
            const bri = Math.round(Math.min(254, Math.max(minBri, minBri + (254 - minBri) * sample.brightness * boost)));
            const hex = rgbToHex(sample.rgb);

            state.liveHex.set(light.id, hex);
            if (light.bulbElement) light.bulbElement.style.color = hex;
            const dot = state.dots.get(light.id);
            if (dot) dot.style.color = hex;

            payload[light.id] = light.supportsColor ? { xy: rgbToXy(...sample.rgb), bri } : { bri };
        }

        if (sending) {
            return;
        }
        sending = true;
        await api('POST', '/api/ambient', { targets: payload, transitiontime: 2 }).catch(() => {});
        sending = false;
    };

    stream.getVideoTracks()[0].addEventListener('ended', stopVision);
    state.vision = { stream, ticker, snapshot };
    $('stage').classList.add('live');

    $('vision-start').classList.add('hidden');
    $('vision-stop').classList.remove('hidden');
    setStatus(`What you see · ${targets.length} light${targets.length > 1 ? 's' : ''}`, 'ok');
}

async function stopVision() {
    const vision = state.vision;
    if (!vision) {
        return;
    }
    state.vision = null;

    vision.ticker.terminate();
    vision.stream.getTracks().forEach((t) => t.stop());
    $('preview').srcObject = null;
    $('stage').classList.remove('live');
    state.liveHex.clear();
    $('vision-start').classList.remove('hidden');
    $('vision-stop').classList.add('hidden');
    document.documentElement.style.removeProperty('--glow');
    setStatus('Connected', 'ok');

    await api('POST', '/api/ambient/stop').catch(() => {});

    if ($('restore').checked) {
        for (const light of vision.snapshot) {
            const restore = { on: light.on, transitiontime: 4 };
            if (light.on && light.bri !== null) restore.bri = light.bri;
            if (light.on && light.colormode === 'ct' && light.ct) restore.ct = light.ct;
            else if (light.on && light.xy) restore.xy = light.xy;
            await setLight(light.id, restore);
        }
    }

    await loadLights();
}

/* ---------------- utils ---------------- */

function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return (...args) => {
        const now = Date.now();
        clearTimeout(timer);
        if (now - last >= ms) {
            last = now;
            fn(...args);
        } else {
            timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
        }
    };
}

function loadJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value !== null && typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback) ? value : fallback;
    } catch {
        return fallback;
    }
}

function saveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage blocked (private mode etc.) - settings just won't survive a reload.
    }
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

refreshStatus().catch((error) => setStatus(error.message, 'bad'));
setInterval(() => !state.vision && !document.hidden && document.activeElement?.type !== 'range' && loadLights(), 15_000);
