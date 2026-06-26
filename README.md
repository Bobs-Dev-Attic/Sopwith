# Sopwith Camel — WWI Flying Ace

A mobile-first 2D side-scrolling flight game. Pilot a WWI Sopwith Camel
biplane through dogfights and bombing runs. Built with plain HTML5 Canvas
and JavaScript — **no build step, no dependencies, no assets to download**.

![landscape](https://img.shields.io/badge/orientation-landscape-blue) ![no--deps](https://img.shields.io/badge/dependencies-none-success)

## Play

Open `index.html` in any modern browser. On a phone, hold it in **landscape**
(a prompt asks you to rotate if you're in portrait).

To run a local server (recommended so everything loads cleanly):

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000 on your phone or desktop
```

Or just double-click `index.html` — it runs from `file://` too.

## Controls

On-screen, designed for thumbs in landscape:

| Control | Action |
| --- | --- |
| **▲ (left)** | Pull up / climb |
| **▼ (left)** | Nose down / dive |
| **Throttle slider (center)** | Vertical speed control — drag up for more speed |
| **🔫 (right)** | Fire the twin Vickers machine guns |
| **💣 (right)** | Drop a bomb on ground targets |

There's an **Invert pitch controls** toggle on the main menu if you prefer
the arrows reversed.

Keyboard (for desktop play/testing): `↑`/`↓` pitch, `←`/`→` throttle,
`Space` fire, `B` bomb, `P` pause.

## Gameplay

- **Altitude-based zoom** — hug the ground and the camera zooms in for
  precise strafing and bombing runs; climb and it zooms out so you can see
  enemy aircraft coming.
- **Flight model** — speed comes from the throttle; pitch sets your climb or
  dive. Fly too slowly and the Camel stalls and sinks, so keep your speed up.
- **Missions**
  1. **Patrol** — a pure dogfight: shoot down enemy Fokkers.
  2. **Bombing Run** — fly low and bomb a supply line. Watch for
     anti-aircraft guns that shoot back.
  3. **All-Out** — a mixed sortie of aircraft and ground installations.
- Land gently or fly near the ground freely; dive into the dirt and you'll
  take damage. Your health bar is top-right.

Jump straight to a mission with `?mission=2` in the URL (handy for replays).

## Project structure

```
index.html      Markup, HUD, on-screen controls, menus
css/style.css   Layout, responsive landscape UI, touch-friendly sizing
js/game.js      Game engine: flight physics, camera/zoom, entities,
                missions, rendering, input
```

All graphics are drawn procedurally on the canvas (the planes, terrain,
clouds, explosions, and targets are vector shapes), so the game stays tiny
and has nothing external to fetch.
