import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(root, 'config.json');
const PUBLIC_DIR = path.join(root, 'public');
const PORT = Number(process.env.PORT ?? 4321);
/** Hue bridges handle ~10 light commands/sec over REST before they start dropping/queueing. */
const COMMANDS_PER_SECOND = Number(process.env.HUE_RATE ?? 10);

let config = existsSync(CONFIG_FILE) ? JSON.parse(await readFile(CONFIG_FILE, 'utf8')) : {};
const saveConfig = () => writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function bridge(method, apiPath, body) {
    if (!config.bridgeIp) {
        throw new HttpError(409, 'No bridge selected');
    }

    const response = await fetch(`http://${config.bridgeIp}/api${apiPath}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(4000),
    });

    return response.json();
}

async function authed(method, apiPath, body) {
    if (!config.username) {
        throw new HttpError(401, 'Not paired with the bridge');
    }

    const result = await bridge(method, `/${config.username}${apiPath}`, body);
    const error = Array.isArray(result) ? result.find((r) => r.error)?.error : null;

    if (error?.type === 1) {
        config.username = null;
        await saveConfig();
        throw new HttpError(401, 'Bridge rejected our key - pair again');
    }

    return result;
}

/* ---------- "What you see" command queue ----------
 * The browser posts target colours as fast as it likes. We keep only the latest
 * target per light and drain round-robin at COMMANDS_PER_SECOND, so the bridge
 * never gets flooded and every light gets its fair share of updates.
 */
const pending = new Map();
const lastSent = new Map();
let inFlight = false;

function enqueue(id, state) {
    const previous = lastSent.get(id);
    const unchanged = previous
        && Math.abs((previous.bri ?? 0) - (state.bri ?? 0)) < 3
        && (!state.xy || (Math.abs(previous.xy[0] - state.xy[0]) + Math.abs(previous.xy[1] - state.xy[1]) < 0.004));

    if (unchanged) {
        pending.delete(id);
        return;
    }

    pending.set(id, state);
}

setInterval(async () => {
    if (inFlight || pending.size === 0 || !config.username) {
        return;
    }

    const [id, state] = pending.entries().next().value;
    pending.delete(id);
    inFlight = true;

    try {
        await authed('PUT', `/lights/${id}/state`, state);
        lastSent.set(id, state);
    } catch (error) {
        console.warn(`light ${id}: ${error.message}`);
    } finally {
        inFlight = false;
    }
}, 1000 / COMMANDS_PER_SECOND);

/* ---------- routes ---------- */

const LIGHT_STATE_KEYS = ['on', 'bri', 'xy', 'ct', 'hue', 'sat', 'transitiontime', 'alert', 'effect'];
const pick = (object, keys) => Object.fromEntries(keys.filter((k) => object[k] !== undefined).map((k) => [k, object[k]]));

const routes = {
    'GET /api/status': async () => {
        let bridgeInfo = null;
        if (config.bridgeIp) {
            bridgeInfo = await bridge('GET', '/0/config').catch(() => null);
        }
        return { bridgeIp: config.bridgeIp ?? null, bridgeName: bridgeInfo?.name ?? null, reachable: !!bridgeInfo, paired: !!config.username };
    },

    'GET /api/discover': async () => {
        const found = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) })
            .then((r) => r.json())
            .catch(() => []);

        return Promise.all(found.map(async ({ internalipaddress: ip }) => {
            const info = await fetch(`http://${ip}/api/0/config`, { signal: AbortSignal.timeout(3000) })
                .then((r) => r.json())
                .catch(() => null);
            return { ip, name: info?.name ?? 'Unknown bridge', reachable: !!info };
        }));
    },

    'POST /api/bridge': async ({ ip }) => {
        if (!/^[\w.-]+$/.test(ip ?? '')) {
            throw new HttpError(422, 'Invalid IP/host');
        }
        if (ip !== config.bridgeIp) {
            config = { bridgeIp: ip, username: null };
            await saveConfig();
        }
        return routes['GET /api/status']();
    },

    'POST /api/pair': async () => {
        const devicetype = `hue_vision#${os.hostname()}`.slice(0, 40);
        const [result] = await bridge('POST', '', { devicetype });

        if (result?.error?.type === 101) {
            throw new HttpError(428, 'Press the round link button on the bridge, then try again');
        }
        if (result?.error) {
            throw new HttpError(502, result.error.description);
        }

        config.username = result.success.username;
        await saveConfig();
        return { paired: true };
    },

    'POST /api/unpair': async () => {
        config.username = null;
        await saveConfig();
        return { paired: false };
    },

    'GET /api/lights': async () => {
        const lights = await authed('GET', '/lights');
        return Object.entries(lights).map(([id, light]) => ({
            id,
            name: light.name,
            type: light.type,
            on: light.state.on,
            bri: light.state.bri ?? null,
            xy: light.state.xy ?? null,
            ct: light.state.ct ?? null,
            colormode: light.state.colormode ?? null,
            reachable: light.state.reachable,
            supportsColor: Array.isArray(light.state.xy),
            supportsDimming: light.state.bri !== undefined,
        }));
    },

    /** Rooms and zones as set up in the Hue app, so the UI can limit itself to one of them. */
    'GET /api/rooms': async () => {
        const groups = await authed('GET', '/groups');
        return Object.entries(groups)
            .filter(([, group]) => group.type === 'Room' || group.type === 'Zone')
            .map(([id, group]) => ({ id, name: group.name, type: group.type, lights: group.lights ?? [] }))
            .sort((a, b) => a.name.localeCompare(b.name));
    },

    'PUT /api/lights/:id': async (body, { id }) => {
        pending.delete(id);
        return authed('PUT', `/lights/${id}/state`, pick(body, LIGHT_STATE_KEYS));
    },

    'PUT /api/all': async (body) => {
        pending.clear();
        return authed('PUT', '/groups/0/action', pick(body, LIGHT_STATE_KEYS));
    },

    'PUT /api/groups/:id': async (body, { id }) => {
        if (!/^\d+$/.test(id)) {
            throw new HttpError(422, 'Invalid group id');
        }
        pending.clear();
        return authed('PUT', `/groups/${id}/action`, pick(body, LIGHT_STATE_KEYS));
    },

    'POST /api/ambient': async ({ targets = {}, transitiontime = 2 }) => {
        for (const [id, target] of Object.entries(targets)) {
            enqueue(id, { ...pick(target, ['xy', 'bri']), transitiontime });
        }
        return { queued: pending.size };
    },

    'POST /api/ambient/stop': async () => {
        pending.clear();
        lastSent.clear();
        return { stopped: true };
    },
};

function matchRoute(method, url) {
    for (const [key, handler] of Object.entries(routes)) {
        const [routeMethod, routePath] = key.split(' ');
        if (routeMethod !== method) {
            continue;
        }
        const names = [];
        const pattern = new RegExp('^' + routePath.replace(/:(\w+)/g, (_, name) => (names.push(name), '([^/]+)')) + '$');
        const match = url.match(pattern);
        if (match) {
            return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])) };
        }
    }
    return null;
}

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100_000) {
            throw new HttpError(413, 'Body too large');
        }
    }
    return raw ? JSON.parse(raw) : {};
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function serveStatic(url, res) {
    const file = path.normalize(path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url));
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404).end('Not found');
        return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;

    if (!url.startsWith('/api/')) {
        return serveStatic(url, res);
    }

    const route = matchRoute(req.method, url);
    if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unknown endpoint' }));
        return;
    }

    try {
        const result = await route.handler(await readBody(req), route.params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
        const status = error.status ?? 502;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`Hue Vision running at http://localhost:${PORT}`);
});
