# Ramp Stunts AR (phase 1 prototype)

Live: https://kkkkkkkeith10.github.io/ramp-stunts-ar/ (repo: https://github.com/Kkkkkkkeith10/ramp-stunts-ar)

Pip stands on the real floor, climbs the real ramp, bets with a ghost car, and hops along the ramp to count it. WebXR in Android Chrome, built with three.js 0.160.0 (vendored in `vendor/`, MIT licence). No backend, no build step.

## Pip's Photo Stage (`stage/`): the no-AR alternative

One photo, no tracking. Depth Anything V2 Small (Apache-2.0, via Transformers.js 3.8.1) guesses depth on the device. The photo is not uploaded; the model (27 MB, or 50 MB with WebGPU) downloads once from Hugging Face. The photo becomes a 3D surface seen from the camera's own viewpoint, so it lines up with the photo and nearer real things hide Pip.

- The floor is fitted (RANSAC) in the lower part of the photo, so Pip stands upright.
- Tap anywhere: Pip hops there over the surface. "Show Pip the ramp": tap its bottom, then its top, and Pip climbs, counting hops. "Pip's ghost car" rolls down the ramp and across the floor.
- Drag to tilt the stage a little. Far tilts stretch the picture: the model only sees the front of things.
- Logic is in `js/photo-geom.js`, tested in `tests/photo-geom.test.js`. `stage/sample-ramp.jpg` is a render from the AR preview's pretend room, not a real photo.
- Checked on the sample: depth in about 1.5 s with WebGPU on a laptop, the floor fit recovered the camera tilt (31 degrees found, about 33 real). Not yet checked on a phone or on real photos.
- **Slopes.** The model gives relative depth (unknown scale and shift). Two fixes:
  1. *Tilt calibration:* the phone's tilt (DeviceOrientation) is read just before and after the camera app opens. Gravity tells us how the floor should face, which solves the depth shift (`calibrateShift`). Library photos have no tilt; "Grown-up settings" lets you set it by hand.
  2. *The bottom touches the floor:* the slope uses the floor plane under the bottom tap, and depth only for the top (`rampFromPhotoTaps`). On the sample render, the model read the plain grey tray as a flat board 10 cm above the floor, so this rule mattered most.
- Results on the sample (true slope 10.6 degrees): 9.0 with the right tilt, 9.3 with no tilt, 8.2 to 9.7 with the tilt 8 degrees off; it read 1 degree before these fixes. In a synthetic test with the camera looking 50 degrees down, calibration corrected 16.3 to 10.7.
- **Sizes from the book count.** Before the child answers, sizes assume the floor is about 1 m away (the sample's 40 cm ramp read 71 cm). After Pip climbs, he asks how many books high the top is; books x book thickness is the real height, and the whole stage is rescaled about the camera (`scaleFromBooks`, `distScale`), so the photo view, Pip's spot and the taps stay put. Pip then says the ramp in game units ("3 books up for every 3 shoes across"). Book thickness and shoe length are in "Grown-up settings" and shared with the AR app on the same phone.
- Sample result after "3 books": 7.5 cm up, 47 cm across (real: 7.5 and 40), 9 degrees. The across error comes from the slope error, so Pip said 3 shoes where the real ramp is about 2.
- Not yet checked: real photos, real phones, and whether every phone's sensor and camera app agree on "up".

`depth/` is the plain depth test: photo, depth map and a tiltable 3D version.

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
