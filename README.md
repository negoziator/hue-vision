# Hue Vision

> Light what you see.

Hue Vision turns your Philips Hue lights into an ambilight for whatever is on your screen. Share a screen, window or tab in the browser and the lights you pick follow its colour and brightness in real time. It also works as a simple Hue control panel: switch lights on and off, dim them and set their colour.

It has no dependencies: one small Node server, one HTML page and a few hundred lines of plain JavaScript.

## Features

- **Bridge discovery and pairing.** Finds Hue bridges on your network and pairs with one link-button press.
- **Light control.** On/off, brightness and colour per light, plus *All on* and *All off*.
- **What you see.** Lights follow the screen you share:
  - **Vivid** mode picks out the saturated colours, so a red logo on a grey UI still shows as red.
  - **Average** mode uses the true average colour of the screen.
  - Brightness follows the scene, so dark scenes dim the room.
  - Sliders for brightness boost, minimum brightness and smoothing.
  - Lights go back to their previous state when you stop, if you want.
- **Doesn't flood the bridge.** Updates are queued per light and sent round-robin at a safe rate (about 10 commands per second).
- **Keeps running in the background.** Sampling runs on a Web Worker timer, so it keeps going while the tab is hidden behind your film or game.

## Requirements

- Node.js **20** or newer
- A Philips Hue bridge on the same network
- A browser that supports screen capture (`getDisplayMedia`), such as Chrome, Edge or Firefox

## Quick start

```bash
npm start
```

Open **http://localhost:4321** and then:

1. **Bridge.** Click *Find bridges*, or type the bridge IP (in the Hue app under Settings → Bridges).
2. **Pair.** Press the round link button on the bridge, then click *Pair*. It keeps retrying for 30 seconds.
3. **Lights.** Tick *Follow screen* on each light that should react.
4. **What you see.** Click *Pick screen & start*, choose a screen or window, and watch the room change.

The bridge IP and API key are stored in `config.json`, which is git-ignored.

## Configuration

| Variable   | Default | Description                                        |
|------------|---------|----------------------------------------------------|
| `PORT`     | `4321`  | Port for the local web server                      |
| `HUE_RATE` | `10`    | Maximum light commands per second sent to the bridge |

```bash
PORT=8080 HUE_RATE=8 npm start
```

The server only listens on `127.0.0.1`, so it is never exposed to your network.

## How it works

```
 Screen ──getDisplayMedia──▶ Browser                        Node server              Hue bridge
                             ├─ downscale frame to 64×36
                             ├─ sampleFrame → colour + brightness
                             ├─ smoothing, CIE xy conversion
                             └─ POST /api/ambient ─────────▶ keep newest target ──▶ PUT /lights/:id/state
                                (12 Hz)                       per light, drain        (≤ HUE_RATE/s)
                                                              round-robin
```

- **`public/color.js`**: colour maths. sRGB to CIE xy (the colour space Hue uses), xy back to a hex preview colour, and the frame sampler.
- **`public/app.js`**: the UI, screen capture, the sampling loop and the Web Worker ticker.
- **`server.mjs`**: serves the page, stores the config, proxies the Hue REST API and runs the rate-limited command queue. Updates that barely change a light are skipped.

### API

| Method & path            | Purpose                                     |
|--------------------------|---------------------------------------------|
| `GET  /api/status`       | Bridge, reachability and pairing status     |
| `GET  /api/discover`     | Find bridges with Hue's discovery service   |
| `POST /api/bridge`       | Select a bridge `{ ip }`                    |
| `POST /api/pair`         | Pair (press the link button first)          |
| `POST /api/unpair`       | Forget the API key                          |
| `GET  /api/lights`       | List lights and their state                 |
| `PUT  /api/lights/:id`   | Set a light's state                         |
| `PUT  /api/all`          | Set the state of all lights (group 0)       |
| `POST /api/ambient`      | Queue screen-follow targets                 |
| `POST /api/ambient/stop` | Clear the queue                             |

## Tests

```bash
npm test
```

The tests use Node's built-in test runner and cover the colour maths and frame sampling.

## Tips

- Share a **window** or a **tab** instead of the whole screen to stop the lights reacting to other things on your desktop.
- For films, turn **Smoothing** up to about 70–80% for calmer changes. For games, turn it down for faster reactions.
- If dark scenes turn the lights off completely, raise **Minimum brightness**.
