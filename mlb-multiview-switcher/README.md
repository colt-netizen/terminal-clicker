# MLB Multiview Audio Switcher

A Chromium (MV3) extension for MLB.tv **multiview**. When the pane that currently
carries audio goes quiet, it promotes another pane — and keeps rotating until it
lands on one that actually has sound.

Built for Comet on macOS, but it is a stock MV3 extension: Chrome, Brave, Edge,
Arc and anything else Chromium-based will load it the same way.

## Install

1. Open the browser's extensions page (`chrome://extensions` — Comet uses the
   same URL) and turn on **Developer mode**.
2. **Load unpacked** → select this `mlb-multiview-switcher/` directory.
3. Open an MLB.tv multiview tab. Click the extension icon to see live status.

## How it decides "audio isn't playing"

The obvious approach — wire the `<video>` into a Web Audio `AnalyserNode` and
measure loudness — is **not usable here**, for two reasons:

- MLB.tv is Widevine (EME) protected. `createMediaElementSource` on protected
  media yields silence, so it would report "no audio" during a perfectly normal
  broadcast.
- That call is a one-way door. Once an element's audio is routed into a Web
  Audio graph you cannot route it back, so a failed attempt permanently kills
  the sound on that stream.

So instead this uses Chrome's own per-tab **`audible`** flag, which the browser
derives below the DRM boundary and exposes for free. Multiview keeps every
non-primary pane muted, which makes "the tab is audible" equivalent to "the
primary pane is making noise" — exactly the signal we want.

**The trade-off:** `audible` is a boolean, not a level, and Chrome applies about
2 seconds of its own hysteresis before flipping it to `false`. With the default
3s threshold the real-world delay is therefore closer to **5 seconds**. Lower
the threshold in Settings if you want it snappier; there is no way to claw back
Chrome's 2s.

## How it decides where to go

It can't know in advance which other game has audio — every non-primary pane is
muted, so they all look silent. Rather than guess, it **rotates**: promote the
next pane, wait out the grace period, and if that one is quiet too, rotate
again. Since audio returning resets everything, the rotation naturally settles
on whichever game is actually live.

If it laps every pane without finding sound, the whole multiview is quiet
(between innings, say) and it backs off for 20s instead of churning.

State machine, with defaults:

```
watching ──silent 3s──> switch ──> grace 4s ──> silent 3s ──> switch ──> …
    ^                                                              │
    └────────────── audio returns (resets attempts) ───────────────┘
                    a full lap with no audio ──> backoff 20s
```

## Promoting a pane

Three layers, applied in order, because MLB's DOM is not a stable contract:

1. Click the pane's own audio control, if one is discoverable by `aria-label` /
   `title`. Going through the page's UI keeps MLB's state consistent.
2. Failing that, dispatch a full pointer + mouse click sequence at the pane's
   centre, aimed at whatever `elementFromPoint` says is on top.
3. Then, regardless, assert the result directly on the media elements
   (`muted` / `volume` / `play()`), carrying the outgoing pane's volume level
   over so it doesn't jump to full blast.

Layer 3 is the backstop that makes this work even when layers 1–2 match nothing.
Its one cosmetic cost: MLB's UI may briefly label a different pane as "active"
than the one the sound is coming from.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Enabled | on | Master switch (also in the popup). |
| Silence before switching | 3000ms | Add ~2s for Chrome's own lag. |
| Grace after a switch | 4000ms | Lets a new pane buffer before it counts as silent. |
| Backoff after a full lap | 20000ms | Cooldown when every pane is quiet. |
| Stand down when tab is muted | on | A muted tab is a deliberate choice. |
| Debug overlay | off | Corner readout: phase, audible, pane count, last action. |
| Pane selector | *(empty)* | CSS escape hatch — see below. |

Changes apply immediately; no tab reload needed.

## If it isn't working

Turn on the **debug overlay** and read `panes`:

- **`panes 0` or `1`** — pane discovery is failing. Either the players sit in an
  iframe on a host this extension isn't injected into, or the heuristic (any
  `<video>` at least 200×100) isn't matching. Fixes: set **Pane selector** to a
  CSS selector matching each pane's container, or add the player's host to
  `matches` / `host_permissions` in `manifest.json` and reload the extension.
- **panes look right but nothing happens** — hit **Switch now** in the popup.
  That rotates immediately and isolates promotion from detection, so you find
  out which half is broken without waiting for dead air.
- **it switches during normal play** — raise the silence threshold. Some
  broadcasts have genuinely quiet stretches.

## Tests

```bash
node --test tests/silence-machine.test.cjs
```

13 tests over the timing logic (thresholds, grace suppression, lap detection,
backoff, attempt reset, the disabled/single-pane no-ops, purity).

**What is not covered:** everything that touches the live site — pane discovery,
container detection, and the click strategies. MLB.tv is behind a paid login and
the markup is unstable, so those layers were written defensively (heuristics
first, direct media control as a guaranteed backstop, CSS override in Settings)
rather than tested against a fixture that would be fiction. The debug overlay
and "Switch now" exist so that layer is diagnosable on the real page in seconds.
