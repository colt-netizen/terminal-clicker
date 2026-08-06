# MLB Multiview Audio Switcher

A Chromium (MV3) extension for MLB.tv **multiview** that keeps you plugged into
live baseball. It knows the state of every game in the league, ranks games by
the teams you care about, moves the audio to the best live game, and — when a
pane's game ends or hasn't started — swaps that pane for a live game via the
page's own rail.

Built for Comet on macOS, but it is a stock MV3 extension: Chrome, Brave, Edge,
Arc and anything else Chromium-based will load it the same way.

## How it knows what's a live game

Two independent sources, no AI, no cost:

- **MLB's public stats API** (`statsapi.mlb.com` — free, unauthenticated, the
  same data the site itself runs on). One ~5KB fetch every 45 seconds, only
  while an MLB tab is open, returns every game's state (Preview / Live / Final),
  the inning (`Bot 8`), both teams, and start times. This is the source of
  truth.
- **The page's game rail** — the strip of cards across the top of multiview
  that prints `Bot 8` / `Final` / `1:20 PM` per game. Parsed as a fallback for
  when the API is unreachable, and used as the *control surface* for loading
  new games into panes.

A pane counts as **live baseball** only if: it has no break banner, its matched
game is In Progress (not Final, not pre-game, not rain-delayed), and it isn't
showing filler ("Coming Up", "First Pitch…").

One asymmetric rule squeezes out extra seconds of baseball without any
flapping: a game sitting **between half-innings** (the API's `Middle`/`End`
inning state — the broadcast's commercial window) is never *chosen as a
destination*, but being between innings is never a reason to *leave* a game
either. So the switcher won't bounce you at every half-inning, but when it does
move — off a break, off a final — it lands on a game where the ball is live,
and return-to-favourite waits until your team is actually back on the field.

## Team priorities

Rank teams in the popup ("SD", "Padres" — abbreviations and names both work).
A game featuring a ranked team outranks every unranked game, whether it's on
screen or not. The per-feed ↑/↓ order still exists as the tiebreak when no
ranked team is involved.

## Auto-tune

When a pane's game is dead (Final, or not started) and a live game exists that
isn't on screen, the extension drives the page's own rail: it focuses the dead
pane, then clicks the target game's card. Your favourite teams pick the target;
the least-favourite dead pane is the one given up.

Every attempt is verified: if the target game doesn't appear among the panes
within 10 seconds, that game is benched for 10 minutes — and after three
consecutive failures auto-tune stops driving the rail entirely (the popup and
HUD say so) rather than clicking a page that isn't responding. Toggling any
setting resets the strikes.

## Install

1. Open the browser's extensions page (`chrome://extensions` — Comet uses the
   same URL) and turn on **Developer mode**.
2. **Load unpacked** → select this `mlb-multiview-switcher/` directory.
3. Open an MLB.tv multiview tab. Click the extension icon to see live status.

## How it decides where the audio should go

MLB renders a literal **“Commercial Break in Progress”** banner into whichever
pane is on a break. That is a per-pane, unambiguous fact — far better than
anything inferable from the audio — so it is the primary signal.

Combined with your priority order, the rule is simply:

> Put the audio on the highest-priority game that is **not** on a commercial break.

Return-to-favourite falls out of that for free: when your top game comes back
from its break it outranks whatever you fell back to, so the next evaluation
moves back on its own. Priorities are keyed by *game*, not by screen position,
so they survive switching between 2-, 3- and 4-game layouts.

Set the order in the popup with the ↑/↓ buttons. Games you've ranked before stay
in the list even when they aren't on screen, so they keep their slot.

If every pane is on a break at once, it holds — trading one break for another
achieves nothing.

## How it decides "audio isn't playing"

This is the secondary signal, for dead air that carries no break banner.

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

**The catch:** `audible` is a boolean, not a level. A commercial break is *not
silent* — stadium echo, crowd murmur and PA bleed keep the tab "audible" the
whole way through, so this flag alone never notices a break. That is exactly why
the banner above is the primary signal.

### Listen mode (optional)

For dead air with no banner, turn on **Listen for dead air** in the popup. It
captures the tab's audio (via `chrome.tabCapture`, which works on protected
streams and never touches the page's media elements) and decides whether anyone
is actually *talking*.

It doesn't use an absolute threshold, because the ambient bed differs per
stadium and per moment. Instead it tracks a noise floor that falls fast and
rises slowly, then calls it commentary when speech-band energy (300–3400Hz) sits
`speechMarginDb` above that floor. Steady crowd noise and walk-up music get
absorbed into the floor within seconds and stop counting; the gaps between words
keep the floor down during real commentary.

Capturing a tab mutes it unless the stream is played back, so the audio graph
forks — one branch to the analyser, one straight to your speakers. Any error
tears the capture down, which restores normal audio.

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
for f in tests/*.cjs; do node --test "$f"; done
```

71 tests over the four pure modules:

- **game-intel** (25) — rail text parsing ("Bot 8" / "Final" / "1:20 PM"),
  stats-API state classification (incl. Warmup, rain delays, Game Over), team
  matching (the LA/LAD/LAA ambiguity, city collisions), team-priority ranking,
  pane liveness, and auto-tune target selection. Fixtures mirror real API
  responses captured live.
- **pane-selector** (20) — priority order, leaving a break, leaving dead games,
  return-to-favourite, holding when everything is dead, 2/3/4-game transitions.
- **silence-machine** (13) — thresholds, grace suppression, backoff, attempt
  reset, the disabled/single-pane no-ops, purity.
- **speech-detector** (13) — steady crowd noise and music rejected, commentary
  detected over a loud bed, the quiet-echoey-break case, transient rejection,
  floor asymmetry.

**What is not covered:** everything that touches the live site — pane discovery,
container detection, and the click strategies. MLB.tv is behind a paid login and
the markup is unstable, so those layers were written defensively (heuristics
first, direct media control as a guaranteed backstop, CSS override in Settings)
rather than tested against a fixture that would be fiction. The debug overlay
and "Switch now" exist so that layer is diagnosable on the real page in seconds.
