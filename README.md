# Hue Vision

> Light what you see.

Hue Vision turns your Philips Hue lights into an ambilight for whatever is on your screen. Share a screen, window or tab in the browser and the lights you pick follow its colour and brightness in real time. It also works as a simple Hue control panel: switch lights on and off, dim them and set their colour.

It has no dependencies: one small Node server, one HTML page and a few hundred lines of plain JavaScript.

## Features

- **Bridge discovery and pairing.** Finds Hue bridges on your network and pairs with one link-button press.
- **Choose a room.** Pick one of the rooms or zones from the Hue app and Hue Vision only shows and controls the lights in it. *All on*, *All off* and *What you see* never touch lights anywhere else in the house.
- **Light control.** On/off, brightness and colour per light, plus *All on* and *All off*.
- **What you see.** Lights follow the screen you share:
  - **Vivid** mode picks out the saturated colours, so a red logo on a grey UI still shows as red.
  - **Average** mode uses the true average colour of the screen.
  - Brightness follows the scene, so dark scenes dim the room.
  - **Light placement.** Drag each light to where it stands around your screen on a small room map. A lamp to the left of the TV follows the left side of the picture, one above it follows the top, and so on. The further a light is from the screen, the wider the area it blends. Lights you don't place follow the whole screen.
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
3. **Room (optional).** Pick a room next to the *Lights* heading, e.g. your office, so nothing elsewhere in the house reacts.
4. **Lights.** Tick *Follow screen* on each light that should react.
5. **Placement (optional).** In *What you see*, drag each light from the tray onto the map around the screen, where it stands in your room. Drag a light back to the tray to make it follow the whole screen again.
6. **What you see.** Click *Pick screen & start*, choose a screen or window, and watch the room change.

The bridge IP and API key are stored in `config.json`, which is git-ignored. The selected room, which lights follow the screen and where they are placed are saved in your browser's local storage.

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
                             ├─ sampleFrame per light → colour + brightness
                             │   (weighted towards the light's placement)
                             ├─ smoothing, CIE xy conversion
                             └─ POST /api/ambient ─────────▶ keep newest target ──▶ PUT /lights/:id/state
                                (12 Hz)                       per light, drain        (≤ HUE_RATE/s)
                                                              round-robin
```

- **`public/color.js`**: colour maths. sRGB to CIE xy (the colour space Hue uses), xy back to a hex preview colour, the frame sampler, and `regionWeights`, which turns a light's position into a per-pixel weighting focused on the nearest part of the screen.
- **`public/app.js`**: the UI, the placement map, screen capture, the per-light sampling loop and the Web Worker ticker.
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
| `GET  /api/rooms`        | List rooms and zones with their light ids   |
| `PUT  /api/lights/:id`   | Set a light's state                         |
| `PUT  /api/groups/:id`   | Set the state of every light in a room/zone |
| `PUT  /api/all`          | Set the state of all lights (group 0)       |
| `POST /api/ambient`      | Queue screen-follow targets                 |
| `POST /api/ambient/stop` | Clear the queue                             |

## Tests

```bash
npm test
```

The tests use Node's built-in test runner and cover the colour maths, frame sampling and placement weighting.

## Tips

- Share a **window** or a **tab** instead of the whole screen to stop the lights reacting to other things on your desktop.
- For films, turn **Smoothing** up to about 70–80% for calmer changes. For games, turn it down for faster reactions.
- If dark scenes turn the lights off completely, raise **Minimum brightness**.
