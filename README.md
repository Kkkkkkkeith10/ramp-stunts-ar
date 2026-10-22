# Ramp Stunts AR (phase 1 prototype)

Pip stands on the real floor, climbs the real ramp, bets with a ghost car, and hops along the ramp to count it. WebXR in Android Chrome, built with three.js 0.160.0 (vendored in `vendor/`, MIT licence). No backend, no build step.

## What it does

| Step | What happens | Tier |
|---|---|---|
| Find the floor | Aim the ring at the floor and tap "Put Pip here". Pip is anchored to that spot (WebXR anchors when the phone has them). | - |
| Show Pip my real ramp | Aim at the foot of the tray, then the floor beside the bottom book, then (optionally) the top edge. | 2 |
| Use numbers instead | Books high and shoes across build a virtual ramp at Pip's spot, side on to the camera. | 1 |
| Bet | Pip's ghost car runs down the ramp to his bet. The child moves a flag on the real floor. | - |
| Launch | The real car does the stunt. The app watches nothing. The child says when it has stopped. | - |
| Where did it stop? | Aim the ring at the car. The app converts the spot to shoes from the foot of the ramp. A manual count is the fallback. | - |
| Compare, Repeat, puzzle, record cards | Same as the 2D demo, with flags on the real floor and Pip hopping in 3D. | - |

The event log keeps the 2D demo's events and adds `ar_session`, `pip_placed`, `ramp_measured` and `landing_aimed`. `ramp_measured.top_hit` records whether the top-edge aim hit something raised (`raised`), fell through to the floor (`floor`), hit something too far away (`far`) or was skipped. That answers the open question of whether a tilted tray gets picked up.

Preview mode ("Try without AR") runs the same game in a pretend room with a pretend car, on any browser. Drag to look around and scroll or pinch to zoom.

## Files

- `index.html`: page, styles, overlay.
- `js/main.js`: AR session, preview mode, game flow.
- `js/scene.js`: three.js objects (Pip, ramp, flags, cars, reticle, pretend room).
- `js/ramp.js`, `js/pip-anim.js`, `js/rules.js`, `js/events.js`: pure logic, tested in Node.
- `sw.js`, `manifest.webmanifest`, `icons/`: let Chrome install the app and run it offline.
- `serve.js`: a tiny static server for testing on a laptop.

## Test

```bash
npm test
```

## Put it on an Android phone

You need Chrome on Android and **Google Play Services for AR** (from the Play Store; many phones have it already). AR only starts on a secure page, so pick one of these.

**A. A public https link (easiest to share).** Host this folder on GitHub Pages or Cloudflare Pages. Open the link in Chrome on the phone, then use the menu's **Add to Home screen** or **Install app** option. After the first visit it works offline. The code becomes public.

**B. From this laptop over Wi-Fi (nothing published).**
1. On the laptop, in this folder: `node serve.js 8080`. Allow Node through the Windows firewall on private networks if asked.
2. On the phone (same Wi-Fi), open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` in Chrome, enable it, add `http://<laptop Wi-Fi IP>:8080` and relaunch Chrome.
3. Open `http://<laptop Wi-Fi IP>:8080` on the phone.

**C. Over USB.** Install Android platform-tools, turn on USB debugging, run `adb reverse tcp:8080 tcp:8080`, then open `http://localhost:8080` on the phone.

## Only a real phone can tell us

- Whether Pip stays put as you walk around (tracking drift, with and without anchors).
- Whether the ring finds plain carpet, shiny tiles or dark floors.
- Whether aiming at the tilted tray returns a raised hit or falls through to the floor (see `top_hit` in the log).
- How accurate the run and the landing distance are, compared with a tape measure.
- Whether the panel and flags are readable at arm's length, and whether a 5 to 8 year old can aim the ring.
- Whether Pip is the right size (about 11 cm tall) next to a real toy car.
- iPhone: Safari is not expected to offer WebXR AR. Not yet checked on a device.

## Known limits

- No video replay in AR. The camera belongs to the AR session, so the slow-motion replay from the 2D demo is not here.
- Pip is drawn over everything. Without depth sensing he cannot hide behind real objects.
- One ramp and one anchor per session. Leaving AR resets the scene but keeps the runs and the log.
