/* =====================================================================
 * SOPWITH CAMEL — WWI Flying Ace
 * A mobile-first 2D side-scroller. Self-contained: no assets, no build.
 * Coordinate system: world units, y-DOWN. Ground plane at worldY = 0,
 * sky is negative y. altitude = -worldY (feet, roughly).
 * ===================================================================== */
(function () {
  "use strict";

  /* Bump this on every update so the home screen shows the current build. */
  const VERSION = "1.8.1";

  /* ------------------------------------------------------------------ *
   * Config / tuning
   * ------------------------------------------------------------------ */
  const CFG = {
    // Flight model
    STALL_SPEED: 90,
    CRUISE_SPEED: 165,
    MAX_SPEED: 300,
    SPEED_EASE: 2.2, // how fast speed follows throttle
    PITCH_RATE: 130, // deg/sec while holding an arrow (brisk enough to loop)
    AUTO_LEVEL: 22, // deg/sec gentle return to level when near level & hands-off
    GRAVITY: 150, // downward sag when below cruise speed
    CRASH_VY: 230, // vertical speed into ground that hurts
    DRAG: 30, // speed bleed that grows with altitude (thin air)
    POWER_FADE: 0.55, // fraction of engine thrust lost at the ceiling
    CEILING_BAND: 380, // ft below MAX_ALT where climb authority fades out
    ROLL_RATE: 9, // how fast the plane rolls upright/inverted about its long axis
    ENEMY_PITCH_MAX: 55, // enemies pitch hard but don't loop
    ENEMY_SPEED_SCALE: 0.82, // enemies fly a bit slower than the player
    ENEMY_GRACE: 10, // seconds of clear sky before enemy planes show up
    ENEMY_FIRE_RANGE: 640, // distance at which an attacker opens fire
    SEP_RADIUS: 100, // start steering away from another plane within this distance
    RAM_RADIUS: 85, // hard "don't ram the player" bubble

    // Camera: zoom is chosen to always frame the ground together with the plane
    ZOOM_GROUND: 1.7, // most zoomed-in (on the deck)
    ZOOM_MIN: 0.14, // most zoomed-out (keeps the ground in view up high)
    VIEW_ALT_SPAN: 1.3, // world units of vertical view added per ft of altitude
    ZOOM_EASE: 2.4,
    MAX_ALT: 1800,

    // Weapons
    FIRE_RATE: 0.11, // sec between bullets
    BULLET_SPEED: 620,
    BULLET_LIFE: 0.9,
    BOMB_COOLDOWN: 0.55,
    BOMB_BLAST: 95,

    // Combat
    PLAYER_HP: 100,
    ENEMY_BULLET_SPEED: 380,

    GROUND_DETAIL: 1, // ground texture density
  };

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const now = () => performance.now() / 1000;
  // normalize an angle (deg) to (-180, 180]
  const normDeg = (a) => {
    a = a % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return a;
  };
  // deterministic hash -> [0,1): stable pseudo-random keyed by an integer, so
  // procedural scenery scrolls with the world instead of flickering each frame
  const hash = (n) => {
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
  };

  /* ------------------------------------------------------------------ *
   * Canvas
   * ------------------------------------------------------------------ */
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let VW = 0,
    VH = 0,
    DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    VW = window.innerWidth;
    VH = window.innerHeight;
    canvas.width = Math.floor(VW * DPR);
    canvas.height = Math.floor(VH * DPR);
    canvas.style.width = VW + "px";
    canvas.style.height = VH + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));
  resize();

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */
  const input = {
    stickX: 0, // analog flight stick: -1 (left) .. +1 (right) -> flips the plane
    stickY: 0, // -1 (stick up) .. +1 (stick down) -> pitch (invert decides which climbs)
    firing: false,
    throttle: 0.55,
    invert: true, // inverted (joystick-style: pull the stick down to climb) by default
    bombQueued: false,
  };
  // separate keyboard axes so a held key and the touch stick don't clobber each other
  let keyX = 0, keyY = 0;

  function bindHold(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      el.classList.add("pressed");
      onDown && onDown();
    };
    const up = (e) => {
      e.preventDefault();
      el.classList.remove("pressed");
      onUp && onUp();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
  }

  const btnFire = document.getElementById("btn-fire");
  const btnBomb = document.getElementById("btn-bomb");
  const throttleEl = document.getElementById("throttle");

  bindHold(
    btnFire,
    () => (input.firing = true),
    () => (input.firing = false)
  );
  bindHold(btnBomb, () => (input.bombQueued = true), null);

  // ---- analog flight stick ----
  const stickEl = document.getElementById("stick");
  const knobEl = document.getElementById("stick-knob");
  let stickPid = null;

  function setKnob(nx, ny) {
    const travel = 30; // % of the base radius the knob visually moves
    knobEl.style.transform = `translate(${nx * travel}%, ${ny * travel}%)`;
  }
  function moveStick(e) {
    e.preventDefault();
    const r = stickEl.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; } // clamp to the unit circle
    input.stickX = dx;
    input.stickY = dy;
    setKnob(dx, dy);
  }
  function endStick(e) {
    if (e.pointerId !== stickPid) return;
    stickPid = null;
    input.stickX = 0;
    input.stickY = 0;
    setKnob(0, 0);
  }
  stickEl.addEventListener("pointerdown", (e) => {
    stickPid = e.pointerId;
    stickEl.setPointerCapture(e.pointerId);
    moveStick(e);
  });
  stickEl.addEventListener("pointermove", (e) => {
    if (e.pointerId === stickPid) moveStick(e);
  });
  stickEl.addEventListener("pointerup", endStick);
  stickEl.addEventListener("pointercancel", endStick);

  throttleEl.addEventListener("input", () => {
    input.throttle = throttleEl.value / 100;
  });
  input.throttle = throttleEl.value / 100;

  // Keyboard (desktop testing / play) — arrows emulate the stick
  function applyKeyAxes() { input.stickX = keyX; input.stickY = keyY; }
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowUp": keyY = -1; applyKeyAxes(); e.preventDefault(); break;
      case "ArrowDown": keyY = 1; applyKeyAxes(); e.preventDefault(); break;
      case "ArrowLeft": keyX = -1; applyKeyAxes(); e.preventDefault(); break;
      case "ArrowRight": keyX = 1; applyKeyAxes(); e.preventDefault(); break;
      case "w": case "W":
        input.throttle = clamp(input.throttle + 0.08, 0, 1);
        throttleEl.value = input.throttle * 100; break;
      case "s": case "S":
        input.throttle = clamp(input.throttle - 0.08, 0, 1);
        throttleEl.value = input.throttle * 100; break;
      case " ": input.firing = true; e.preventDefault(); break;
      case "b": case "B": input.bombQueued = true; break;
      case "p": case "P": togglePause(); break;
    }
  });
  window.addEventListener("keyup", (e) => {
    switch (e.key) {
      case "ArrowUp": case "ArrowDown": keyY = 0; applyKeyAxes(); break;
      case "ArrowLeft": case "ArrowRight": keyX = 0; applyKeyAxes(); break;
      case " ": input.firing = false; break;
    }
  });

  const invertChk = document.getElementById("invert-pitch");
  invertChk.checked = input.invert; // reflect the default on the menu toggle
  invertChk.addEventListener("change", () => (input.invert = invertChk.checked));

  /* ------------------------------------------------------------------ *
   * Camera
   * ------------------------------------------------------------------ */
  const cam = { x: 0, y: 0, zoom: 1 };

  function worldToScreen(wx, wy) {
    return {
      x: (wx - cam.x) * cam.zoom + VW * 0.4,
      y: (wy - cam.y) * cam.zoom + VH * 0.58,
    };
  }

  /* ------------------------------------------------------------------ *
   * Entities
   * ------------------------------------------------------------------ */
  const player = {
    x: 0,
    y: -40,
    pitch: 0, // heading in the vertical plane (loops fully); also sets travel direction
    rollFlip: 1, // +1 upright, -1 rolled upside-down (about the long axis)
    rollAnim: 1, // eased toward rollFlip; the rendered vertical scale (rolls through 0)
    rollLatch: false, // edge-detect so a held stick rolls once, not continuously
    speed: CFG.CRUISE_SPEED,
    hp: CFG.PLAYER_HP,
    alive: true,
    fireCd: 0,
    bombCd: 0,
    bombs: 0,
    onGround: false,
    invuln: 0,
  };

  let bullets = []; // {x,y,vx,vy,life,from}
  let bombs = []; // {x,y,vx,vy}
  let enemies = []; // enemy planes
  let targets = []; // ground targets
  let particles = [];
  let clouds = [];
  let hills = [];
  let flak = []; // ambient anti-aircraft bursts in the sky {x,y,t,life,r}
  let flakTimer = 2;

  let score = 0;

  /* --------------------------- Spawning ----------------------------- */
  function spawnClouds() {
    clouds = [];
    for (let i = 0; i < 26; i++) {
      clouds.push({
        x: rand(-400, 4000),
        y: -rand(200, CFG.MAX_ALT),
        s: rand(0.7, 1.8),
        depth: rand(0.25, 0.6),
      });
    }
  }

  function spawnHills() {
    hills = [];
    let hx = -800;
    while (hx < 6000) {
      hills.push({ x: hx, h: rand(120, 320), w: rand(400, 800) });
      hx += rand(300, 600);
    }
  }

  const ENEMY_PATTERNS = ["chaser", "strafer", "highdive"];

  function makeEnemy(x, alt) {
    return {
      x,
      y: -alt,
      pitch: 0,
      speed: rand(140, 180),
      hp: 2,
      fireCd: rand(0.6, 2.0),
      dir: -1,
      alive: true,
      kind: "fokker",
      // --- AI / tactics ---
      pattern: ENEMY_PATTERNS[randi(0, ENEMY_PATTERNS.length - 1)],
      mode: "ingress", // ingress -> attack -> extend -> ingress ...
      modeT: 0, // time left in the current mode
      passSign: Math.random() < 0.5 ? 1 : -1, // which side of the player we slide past
      lastDx: 0,
    };
  }

  function makeTarget(x, type) {
    const defs = {
      tent: { w: 60, h: 40, hp: 1, score: 80, aa: false },
      truck: { w: 70, h: 34, hp: 1, score: 100, aa: false },
      depot: { w: 110, h: 70, hp: 2, score: 200, aa: false },
      aa: { w: 54, h: 44, hp: 2, score: 150, aa: true },
      hangar: { w: 140, h: 80, hp: 3, score: 300, aa: false },
    };
    const d = defs[type] || defs.tent;
    return {
      x,
      type,
      w: d.w,
      h: d.h,
      hp: d.hp,
      score: d.score,
      aa: d.aa,
      fireCd: rand(1.5, 3.5),
      alive: true,
      destroyed: false,
    };
  }

  function addExplosion(x, y, big) {
    const n = big ? 34 : 16;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, big ? 320 : 180);
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 30,
        life: rand(0.3, big ? 1.1 : 0.7),
        maxLife: 1,
        r: rand(2, big ? 7 : 4),
        col: i % 3 === 0 ? "#ffd24a" : i % 3 === 1 ? "#ff7a33" : "#7a4a2a",
        grav: 120,
      });
    }
    // shockwave ring
    particles.push({
      x, y, vx: 0, vy: 0, life: 0.35, maxLife: 0.35,
      r: 4, ring: true, col: "#fff4cc", grav: 0,
    });
  }

  function addSmoke(x, y) {
    particles.push({
      x, y,
      vx: rand(-15, 15),
      vy: rand(-40, -10),
      life: rand(0.5, 1.1),
      maxLife: 1,
      r: rand(3, 6),
      col: "rgba(60,60,60,0.5)",
      grav: -20,
      smoke: true,
    });
  }

  function muzzleFlash(x, y) {
    particles.push({
      x, y, vx: 0, vy: 0, life: 0.05, maxLife: 0.05, r: 6,
      col: "#fff1b0", grav: 0,
    });
  }

  /* ------------------------------------------------------------------ *
   * Missions
   * ------------------------------------------------------------------ */
  const MISSIONS = [
    {
      title: "Mission 1 — Bombing Run",
      brief:
        "Take off and head for the enemy supply line. Fly low and drop bombs on 5 ground targets. Watch for anti-aircraft guns!",
      type: "bombing",
      goal: 5,
      bombs: 12,
      setup() {
        let x = player.x + 900;
        const types = ["tent", "truck", "depot", "aa", "hangar", "truck", "tent"];
        for (let i = 0; i < 9; i++) {
          targets.push(makeTarget(x, types[i % types.length]));
          x += rand(280, 520);
        }
      },
      tick() {},
    },
    {
      title: "Mission 2 — Duel",
      brief:
        "A lone enemy ace is hunting your patrol. One Camel, one Fokker — climb to meet him and shoot him down.",
      type: "dogfight",
      goal: 1,
      bombs: 0,
      setup() {
        // The duelist arrives after the grace period (see tick).
      },
      tick(s) {
        if (s.grace > 0) return;
        // keep exactly one tough adversary in the air until he's downed
        if (missionProgress < this.goal && enemies.length < 1) {
          const ace = makeEnemy(player.x + (Math.random() < 0.5 ? 1 : -1) * rand(900, 1400), rand(400, 800));
          ace.hp = 4; // an ace takes a few good bursts
          enemies.push(ace);
        }
      },
    },
    {
      title: "Mission 3 — All-Out",
      brief:
        "The big push. Destroy 8 targets — planes in the air and installations on the ground. Use guns and bombs.",
      type: "mixed",
      goal: 8,
      bombs: 14,
      setup() {
        // Ground targets are placed up ahead; enemy planes hold off until the
        // grace period ends.
        let x = player.x + 800;
        const types = ["truck", "aa", "depot", "hangar", "aa", "tent"];
        for (let i = 0; i < 7; i++) {
          targets.push(makeTarget(x, types[i % types.length]));
          x += rand(320, 560);
        }
      },
      tick(s) {
        if (s.grace > 0) return;
        if (enemies.length < 3 && Math.random() < 0.012) {
          enemies.push(makeEnemy(player.x + (Math.random() < 0.5 ? 1 : -1) * rand(1000, 1700), rand(300, 850)));
        }
      },
    },
  ];

  /* ------------------------------------------------------------------ *
   * Game state
   * ------------------------------------------------------------------ */
  const STATE = { MENU: 0, BRIEF: 1, PLAY: 2, PAUSE: 3, RESULT: 4 };
  let state = STATE.MENU;
  let missionIndex = 0;
  let mission = null;
  let missionProgress = 0;
  let missionState = null;

  function startMission(idx) {
    missionIndex = clamp(idx, 0, MISSIONS.length - 1);
    mission = MISSIONS[missionIndex];

    // reset world
    bullets = [];
    bombs = [];
    enemies = [];
    targets = [];
    particles = [];
    flak = [];
    flakTimer = 2;
    missionProgress = 0;
    missionState = { spawned: 0, grace: CFG.ENEMY_GRACE };

    // reset player on the runway
    player.x = 0;
    player.y = -8;
    player.pitch = 0;
    player.rollFlip = 1;
    player.rollAnim = 1;
    player.rollLatch = false;
    player.speed = CFG.STALL_SPEED + 20;
    player.hp = CFG.PLAYER_HP;
    player.alive = true;
    player.onGround = true;
    player.bombs = mission.bombs;
    player.fireCd = 0;
    player.bombCd = 0;
    player.invuln = 1.5;

    cam.x = player.x;
    cam.y = player.y;
    cam.zoom = CFG.ZOOM_GROUND;

    spawnClouds();
    spawnHills();
    mission.setup();

    showBriefing();
  }

  function missionComplete() {
    state = STATE.RESULT;
    document.getElementById("result-title").textContent = "Mission Complete!";
    const last = missionIndex >= MISSIONS.length - 1;
    document.getElementById("result-text").innerHTML =
      `Score: <b>${score}</b><br/>` +
      (last
        ? "You've cleared every mission. Ace of the skies!"
        : "Next sortie awaits.");
    const btn = document.getElementById("btn-result-next");
    btn.textContent = last ? "PLAY AGAIN" : "NEXT MISSION";
    showScreen("result");
  }

  function gameOver() {
    state = STATE.RESULT;
    document.getElementById("result-title").textContent = "Shot Down";
    document.getElementById("result-text").innerHTML =
      `Your Camel went down behind enemy lines.<br/>Score: <b>${score}</b>`;
    document.getElementById("btn-result-next").textContent = "RETRY";
    showScreen("result");
  }

  /* ------------------------------------------------------------------ *
   * Update
   * ------------------------------------------------------------------ */
  function update(dt) {
    if (state !== STATE.PLAY) return;

    if (missionState.grace > 0) missionState.grace -= dt;

    updatePlayer(dt);
    updateWeapons(dt);
    updateEnemies(dt);
    updateTargets(dt);
    updateBombs(dt);
    updateParticles(dt);
    updateFlak(dt);
    updateCamera(dt);

    mission.tick(missionState);

    // win condition
    if (missionProgress >= mission.goal) {
      missionComplete();
    }
    if (!player.alive) {
      gameOver();
    }
  }

  function updatePlayer(dt) {
    const p = player;
    if (p.invuln > 0) p.invuln -= dt;

    const altNow = Math.max(0, -p.y);
    const altFactor = clamp(altNow / CFG.MAX_ALT, 0, 1);

    // ---- flight stick: vertical = pitch ----
    // pitchCmd > 0 means "pull back" (toward the canopy). The stick's vertical
    // axis is screen-down positive; inverting (the default) means pulling the
    // stick down pulls back. The plane's roll orientation flips which way "back"
    // rotates the heading: when you're rolled belly-up, pulling back pitches the
    // nose the other way (just like real inverted flight) — and that's exactly
    // what makes the controls right again after a 180° loop + roll upright.
    const rollSign = p.rollFlip >= 0 ? 1 : -1;
    const pitchCmd = (input.invert ? input.stickY : -input.stickY) * rollSign;
    if (Math.abs(pitchCmd) > 0.04) {
      p.pitch += pitchCmd * CFG.PITCH_RATE * dt;
    } else if (Math.abs(p.pitch) < 45) {
      // gentle auto-level near level (never fights you over the top of a loop)
      if (Math.abs(p.pitch) < CFG.AUTO_LEVEL * dt) p.pitch = 0;
      else p.pitch -= Math.sign(p.pitch) * CFG.AUTO_LEVEL * dt;
    }
    p.pitch = normDeg(p.pitch); // wrap so the nose can swing all the way around
    const pr = p.pitch * DEG;

    // stick left/right rolls the plane about its long axis (a barrel roll):
    // it flips upside-down <-> right-side-up but keeps flying the same way.
    // Reversing course is done by looping (pitch), which leaves you inverted —
    // then a roll brings you upright again. Edge-detected so a held stick rolls
    // once. rollAnim eases through 0 (knife-edge) for the roll animation.
    if (Math.abs(input.stickX) > 0.5) {
      if (!p.rollLatch) { p.rollFlip = -p.rollFlip; p.rollLatch = true; }
    } else if (Math.abs(input.stickX) < 0.3) {
      p.rollLatch = false;
    }
    p.rollAnim += (p.rollFlip - p.rollAnim) * clamp(CFG.ROLL_RATE * dt, 0, 1);

    // ---- speed from throttle, with altitude power-fade + drag ----
    const powerScale = 1 - CFG.POWER_FADE * altFactor; // thinner air, less thrust
    const target = CFG.STALL_SPEED + input.throttle * (CFG.MAX_SPEED - CFG.STALL_SPEED) * powerScale;
    p.speed += (target - p.speed) * clamp(CFG.SPEED_EASE * dt, 0, 1);
    // aerodynamic drag that bites harder the higher you are
    p.speed -= CFG.DRAG * altFactor * (p.speed / CFG.CRUISE_SPEED) * dt;
    if (p.speed < 0) p.speed = 0;

    // ---- velocity (travels along the nose; loops carry you west and back) ----
    let vx = p.speed * Math.cos(pr);
    let vy = -p.speed * Math.sin(pr);
    // gravity sag when below cruise speed (stall)
    const sag = CFG.GRAVITY * Math.max(0, 1 - p.speed / CFG.CRUISE_SPEED);
    vy += sag;
    // soft service ceiling: climb authority fades out in the top band so the
    // plane settles at its limit instead of slamming into a hard clamp
    if (vy < 0) {
      const ceilDamp = clamp((CFG.MAX_ALT - altNow) / CFG.CEILING_BAND, 0, 1);
      vy *= ceilDamp;
    }

    p.x += vx * dt;
    p.y += vy * dt;

    // ---- ground interaction ----
    const alt = -p.y;
    p.onGround = false;
    if (alt <= 0) {
      p.y = 0;
      p.onGround = true;
      const descending = vy;
      const tooSteep = p.pitch < -18 || Math.abs(p.pitch) > 100; // nose-down or inverted into the dirt
      if ((descending > CFG.CRASH_VY || tooSteep) && p.invuln <= 0) {
        damagePlayer(40, true);
        // bounce the nose up so we don't insta-die
        p.pitch = 10;
        p.y = -2;
      } else {
        // taxi / gentle: level out, sit on ground
        if (p.pitch < 0) p.pitch = 0;
      }
    }
    if (alt > CFG.MAX_ALT) {
      p.y = -CFG.MAX_ALT;
    }

    // engine smoke trail when damaged
    if (p.hp < 35 && Math.random() < 0.5) {
      addSmoke(p.x - Math.cos(pr) * 16, p.y + Math.sin(pr) * 16);
    }
  }

  function updateCamera(dt) {
    const alt = Math.max(0, -player.y);

    // Choose a zoom that fits the ground line and the plane in the viewport at
    // the same time: the higher you climb, the more vertical world we show, so
    // the ground stays visible no matter the altitude.
    const span = Math.max(VH / CFG.ZOOM_GROUND, alt * CFG.VIEW_ALT_SPAN + VH * 0.4);
    const targetZoom = clamp(VH / span, CFG.ZOOM_MIN, CFG.ZOOM_GROUND);
    cam.zoom += (targetZoom - cam.zoom) * clamp(CFG.ZOOM_EASE * dt, 0, 1);

    // follow player, look a little ahead in the direction of travel
    const lookAhead = clamp(player.speed * 0.5, 0, 180);
    const headX = Math.cos(player.pitch * DEG); // +east / -west
    const tx = player.x + (Math.abs(headX) < 0.2 ? 0 : Math.sign(headX)) * lookAhead;
    cam.x += (tx - cam.x) * clamp(6 * dt, 0, 1);

    // Vertically sit the camera between the plane and the ground (worldY 0),
    // biased slightly toward the plane so there's sky to climb into. This keeps
    // both the aircraft and the ground on screen together.
    const ty = player.y * 0.5 - 20;
    cam.y += (ty - cam.y) * clamp(4 * dt, 0, 1);
  }

  // The world-space offset of whichever fuselage side currently points at the
  // ground (belly when upright, cockpit when rolled inverted). Mirrors the
  // sprite transform: model point -> rotate(-pitch) -> vertical flip (rollAnim).
  function planeDownPoint(p) {
    const pr = p.pitch * DEG;
    const k = 0.9; // model units -> world units (drawn at zoom * 0.9)
    const pts = [[0, 6.5], [-2, -6]]; // belly, cockpit (model space)
    let best = { wx: 0, wy: 0 };
    let bestWy = -Infinity;
    for (const [lx, ly] of pts) {
      const rx = lx * Math.cos(pr) + ly * Math.sin(pr);
      const ry = (-lx * Math.sin(pr) + ly * Math.cos(pr)) * p.rollAnim;
      if (ry > bestWy) { bestWy = ry; best = { wx: rx * k, wy: ry * k }; }
    }
    return best;
  }

  function updateWeapons(dt) {
    const p = player;
    p.fireCd -= dt;
    p.bombCd -= dt;

    if (input.firing && p.fireCd <= 0 && p.alive) {
      p.fireCd = CFG.FIRE_RATE;
      const pr = p.pitch * DEG;
      // guns fire straight along the nose (roll doesn't change where they point)
      const dx = Math.cos(pr), dy = -Math.sin(pr);
      const nx = p.x + dx * 22, ny = p.y + dy * 22;
      bullets.push({
        x: nx, y: ny,
        vx: dx * (CFG.BULLET_SPEED + p.speed),
        vy: dy * CFG.BULLET_SPEED,
        life: CFG.BULLET_LIFE,
        from: "player",
      });
      muzzleFlash(nx, ny);
    }

    if (input.bombQueued) {
      input.bombQueued = false;
      if (p.bombCd <= 0 && p.bombs > 0 && p.alive) {
        p.bombCd = CFG.BOMB_COOLDOWN;
        p.bombs--;
        const pr = p.pitch * DEG;
        // release from whichever side faces the ground: the belly when upright,
        // the pilot's cockpit when inverted. Then gravity takes it.
        const rel = planeDownPoint(p);
        bombs.push({
          x: p.x + rel.wx,
          y: p.y + rel.wy,
          vx: Math.cos(pr) * p.speed * 0.8,
          vy: -Math.sin(pr) * p.speed * 0.5 + 20,
        });
      }
    }

    // advance bullets
    for (const b of bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
    }
    bullets = bullets.filter((b) => {
      if (b.life <= 0) return false;
      if (-b.y < -10) return false; // underground
      return true;
    });

    // bullet collisions
    for (const b of bullets) {
      if (b.from === "player") {
        for (const e of enemies) {
          if (!e.alive) continue;
          if (Math.hypot(b.x - e.x, b.y - e.y) < 26) {
            e.hp--;
            b.life = 0;
            addExplosion(b.x, b.y, false);
            if (e.hp <= 0) killEnemy(e);
            break;
          }
        }
        // player bullets can also strafe ground targets a little
        for (const t of targets) {
          if (t.destroyed) continue;
          if (b.x > t.x - t.w / 2 && b.x < t.x + t.w / 2 && -b.y < t.h && -b.y > -10) {
            t.hp -= 0.5;
            b.life = 0;
            addExplosion(b.x, b.y, false);
            if (t.hp <= 0) killTarget(t);
            break;
          }
        }
      } else {
        // enemy bullet vs player
        if (player.invuln <= 0 && Math.hypot(b.x - player.x, b.y - player.y) < 20) {
          b.life = 0;
          damagePlayer(12, false);
          addExplosion(b.x, b.y, false);
        }
      }
    }
    bullets = bullets.filter((b) => b.life > 0);
  }

  function updateBombs(dt) {
    for (const bomb of bombs) {
      bomb.vy += 320 * dt; // gravity
      bomb.x += bomb.vx * dt;
      bomb.y += bomb.vy * dt;
    }
    const survivors = [];
    for (const bomb of bombs) {
      if (-bomb.y <= 0) {
        // hit ground -> blast
        addExplosion(bomb.x, 0, true);
        for (const t of targets) {
          if (t.destroyed) continue;
          if (Math.abs(bomb.x - t.x) < CFG.BOMB_BLAST + t.w / 2) {
            t.hp -= 2;
            if (t.hp <= 0) killTarget(t);
          }
        }
        continue; // remove bomb
      }
      survivors.push(bomb);
    }
    bombs = survivors;
  }

  function updateEnemies(dt) {
    const grace = missionState && missionState.grace > 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = player.x - e.x;
      const dy = player.y - e.y;
      const dist = Math.hypot(dx, dy);
      const ealt = Math.max(0, -e.y);
      const palt = Math.max(0, -player.y);
      e.modeT -= dt;

      // -------- tactics: a small attack-pattern state machine --------
      // Each pilot runs an ingress -> firing pass -> extend/reposition cycle,
      // flavoured by its pattern, instead of just pointing at the player.
      const above = e.pattern === "highdive" ? 300 : e.pattern === "strafer" ? 60 : 0;
      let targetAlt;
      let wantDir = dx < 0 ? -1 : 1; // face the player by default
      let thr = 0.82;

      if (e.mode === "ingress") {
        // close in and set up co-altitude (or above, for a diver)
        targetAlt = palt + above;
        if (dist < CFG.ENEMY_FIRE_RANGE && Math.abs(palt - ealt) < 130) {
          e.mode = "attack";
          e.modeT = rand(1.1, 2.0);
        }
      } else if (e.mode === "attack") {
        // a committed firing pass, sliding just above/below so we don't ram
        targetAlt = palt + e.passSign * 38;
        thr = 0.97; // pour on speed for the pass
        const overshot = Math.sign(dx) !== Math.sign(e.lastDx) && e.lastDx !== 0;
        if (e.modeT <= 0 || overshot) {
          e.mode = "extend";
          e.modeT = rand(1.3, 2.3);
          e.passSign = -e.passSign; // come back on the other side next time
        }
      } else {
        // extend: blow through, gain separation, then climb back for another go
        wantDir = dx < 0 ? 1 : -1; // fly AWAY from the player
        targetAlt = palt + (e.pattern === "highdive" ? 360 : 150);
        thr = 0.9;
        if (e.modeT <= 0 && dist > 540) e.mode = "ingress";
      }
      e.lastDx = dx;
      targetAlt = Math.max(targetAlt, 150); // stay off the deck

      // -------- separation: avoid other planes, and never ram the player --------
      let sepY = 0;
      let crowdedAhead = false;
      for (const o of enemies) {
        if (o === e || !o.alive) continue;
        const od = Math.hypot(o.x - e.x, o.y - e.y);
        if (od > 0 && od < CFG.SEP_RADIUS) {
          sepY += Math.sign(e.y - o.y || 1) * (CFG.SEP_RADIUS - od);
          if (Math.sign(o.x - e.x) === wantDir && Math.abs(o.x - e.x) < CFG.SEP_RADIUS * 0.7)
            crowdedAhead = true;
        }
      }
      if (dist < CFG.RAM_RADIUS) {
        // peel away from the player rather than colliding
        sepY += Math.sign(e.y - player.y || 1) * (CFG.RAM_RADIUS - dist) * 1.7;
        if (Math.sign(dx) === wantDir) crowdedAhead = true;
      }
      targetAlt += -sepY * 0.5; // sepY > 0 pushes the plane downward (away)
      if (crowdedAhead) thr *= 0.7; // ease off if someone's right in front

      // -------- convert the desired altitude into a stick input --------
      const vErr = -targetAlt - e.y; // +ve => need to descend
      let desiredPitch = clamp(Math.atan2(-vErr, 150) / DEG, -CFG.ENEMY_PITCH_MAX, CFG.ENEMY_PITCH_MAX);
      if (ealt < 160) desiredPitch = Math.max(desiredPitch, ((160 - ealt) / 160) * 35);
      e.dir = wantDir;
      e.pitch += clamp(desiredPitch - e.pitch, -CFG.PITCH_RATE * dt, CFG.PITCH_RATE * dt);

      // -------- flight physics (identical model to the player) --------
      const altF = clamp(ealt / CFG.MAX_ALT, 0, 1);
      const tgt = (CFG.STALL_SPEED + thr * (CFG.MAX_SPEED - CFG.STALL_SPEED) * (1 - CFG.POWER_FADE * altF)) * CFG.ENEMY_SPEED_SCALE;
      e.speed += (tgt - e.speed) * clamp(CFG.SPEED_EASE * dt, 0, 1);
      e.speed -= CFG.DRAG * altF * (e.speed / CFG.CRUISE_SPEED) * dt;
      if (e.speed < 0) e.speed = 0;

      const pr = e.pitch * DEG;
      let vx = e.dir * e.speed * Math.cos(pr);
      let vy = -e.speed * Math.sin(pr);
      vy += CFG.GRAVITY * Math.max(0, 1 - e.speed / CFG.CRUISE_SPEED); // stall sag
      if (vy < 0) vy *= clamp((CFG.MAX_ALT - ealt) / CFG.CEILING_BAND, 0, 1); // soft ceiling
      e.x += vx * dt;
      e.y += vy * dt;
      if (-e.y < 22) {
        e.y = -22;
        if (e.pitch < 0) e.pitch = 0;
      }

      // -------- guns: only on a committed pass, lined up, after grace --------
      e.fireCd -= dt;
      const aligned =
        !grace && e.mode === "attack" &&
        Math.abs(dy) < 70 && Math.abs(dx) < CFG.ENEMY_FIRE_RANGE && Math.sign(dx) === e.dir;
      if (e.fireCd <= 0 && aligned) {
        e.fireCd = rand(0.16, 0.26); // a short burst during the pass
        const ang = Math.atan2(player.y - e.y, player.x - e.x);
        bullets.push({
          x: e.x + e.dir * 18,
          y: e.y,
          vx: Math.cos(ang) * CFG.ENEMY_BULLET_SPEED,
          vy: Math.sin(ang) * CFG.ENEMY_BULLET_SPEED,
          life: 1.6,
          from: "enemy",
        });
      }

      // collision with player (a last resort — they actively try to avoid it)
      if (player.invuln <= 0 && dist < 30) {
        damagePlayer(45, true);
        killEnemy(e);
      }

      // cull only when far behind AND extending away (so they can loop back to re-engage)
      if (Math.abs(e.x - player.x) > 3400) e.alive = false;
    }
    enemies = enemies.filter((e) => e.alive);
  }

  function updateTargets(dt) {
    const grace = missionState && missionState.grace > 0;
    for (const t of targets) {
      if (t.destroyed || !t.aa) continue;
      t.fireCd -= dt;
      const dx = player.x - t.x;
      const dist = Math.hypot(dx, player.y);
      if (!grace && t.fireCd <= 0 && dist < 900 && -player.y > 20) {
        t.fireCd = rand(1.4, 2.6);
        const ang = Math.atan2(player.y - -t.h, player.x - t.x);
        bullets.push({
          x: t.x,
          y: -t.h,
          vx: Math.cos(ang) * CFG.ENEMY_BULLET_SPEED * 0.9,
          vy: Math.sin(ang) * CFG.ENEMY_BULLET_SPEED * 0.9,
          life: 2.4,
          from: "enemy",
        });
      }
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life -= dt;
      if (p.ring) {
        p.r += 240 * dt;
        continue;
      }
      p.vy += (p.grav || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.smoke) p.r += 8 * dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  // Ambient flak: distant anti-aircraft bursts pepper the sky for atmosphere.
  function updateFlak(dt) {
    flakTimer -= dt;
    if (flakTimer <= 0 && flak.length < 14) {
      flakTimer = rand(0.5, 1.6);
      const headX = Math.cos(player.pitch * DEG) >= 0 ? 1 : -1;
      const ahead = headX * rand(120, 900);
      flak.push({
        x: player.x + ahead + rand(-400, 400),
        y: player.y + rand(-260, 120) - 80, // around/above the player, never underground
        t: 0,
        life: rand(1.8, 3.2),
        r: rand(7, 13),
      });
    }
    for (const f of flak) {
      f.t += dt;
      f.y -= 6 * dt; // smoke drifts up
    }
    flak = flak.filter((f) => f.t < f.life && -f.y > 10);
  }

  function drawFlak() {
    for (const f of flak) {
      const s = worldToScreen(f.x, f.y);
      const z = cam.zoom;
      const k = f.t / f.life;
      if (f.t < 0.09) {
        // initial burst flash
        ctx.fillStyle = "rgba(255,236,180,0.9)";
        ctx.beginPath();
        ctx.arc(s.x, s.y, (f.r + 3) * z, 0, TAU);
        ctx.fill();
      }
      // dark smoke puff, expanding and fading
      const rr = f.r * (0.5 + k * 1.4) * z;
      ctx.fillStyle = `rgba(28,26,28,${0.5 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, rr, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(12,12,14,${0.4 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(s.x - rr * 0.2, s.y + rr * 0.1, rr * 0.6, 0, TAU);
      ctx.fill();
    }
  }

  // A drifting smog haze and a dark vignette to seat the gloomy mood.
  function drawAtmosphere() {
    // overall darkening toward a smoky teal
    ctx.fillStyle = "rgba(18,22,24,0.16)";
    ctx.fillRect(0, 0, VW, VH);

    // slow horizontal haze bands
    const T = now();
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const y = VH * (0.3 + i * 0.22) + Math.sin(T * 0.1 + i) * 10;
      const h = VH * 0.22;
      const gr = ctx.createLinearGradient(0, y - h, 0, y + h);
      gr.addColorStop(0, "rgba(120,120,124,0)");
      gr.addColorStop(0.5, `rgba(120,120,124,${0.05 + i * 0.015})`);
      gr.addColorStop(1, "rgba(120,120,124,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(0, y - h, VW, h * 2);
    }
    ctx.restore();

    // vignette
    const v = ctx.createRadialGradient(VW * 0.5, VH * 0.46, VH * 0.3, VW * 0.5, VH * 0.5, VH * 0.85);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(6,8,10,0.42)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, VW, VH);
  }

  function killEnemy(e) {
    if (!e.alive) return;
    e.alive = false;
    addExplosion(e.x, e.y, true);
    score += 120;
    missionProgress++;
  }

  function killTarget(t) {
    if (t.destroyed) return;
    t.destroyed = true;
    addExplosion(t.x, -8, true);
    score += t.score;
    missionProgress++;
  }

  function damagePlayer(amount, big) {
    if (player.invuln > 0 || !player.alive) return;
    player.hp -= amount;
    player.invuln = 0.6;
    if (big) addExplosion(player.x, player.y, false);
    if (player.hp <= 0) {
      player.hp = 0;
      player.alive = false;
      addExplosion(player.x, player.y, true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */
  function render() {
    const alt = Math.max(0, -player.y);
    drawSky(alt);
    drawHills();
    drawTreeline();
    drawSmokeColumns();
    drawClouds();
    drawGround();
    drawBattlefield();
    drawTargets();
    drawBombs();
    drawFlak();
    drawEnemies();
    if (player.alive || (Math.floor(now() * 10) % 2 === 0))
      drawPlayer();
    drawBullets();
    drawParticles();
    drawAtmosphere();
    if (state === STATE.PLAY) updateHUD(alt);
  }

  const sunPos = () => ({ x: VW * 0.78, y: VH * 0.2 });

  function drawSky(alt) {
    const t = clamp(alt / CFG.MAX_ALT, 0, 1);
    const rgb = (r, g, b) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    // dark, overcast war sky: heavy grey, with a dim smoky band near the horizon
    g.addColorStop(0, rgb(lerp(58, 16, t), lerp(66, 30, t), lerp(78, 48, t)));
    g.addColorStop(0.5, rgb(lerp(96, 52, t), lerp(102, 66, t), lerp(110, 84, t)));
    g.addColorStop(0.82, rgb(lerp(132, 92, t), lerp(126, 92, t), lerp(120, 96, t)));
    g.addColorStop(1, rgb(lerp(150, 104, t), lerp(126, 92, t), lerp(98, 78, t)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    // a heavy overcast cloud bank smothering the top of the sky
    ctx.save();
    const ob = ctx.createLinearGradient(0, 0, 0, VH * 0.5);
    ob.addColorStop(0, "rgba(26,28,32,0.55)");
    ob.addColorStop(1, "rgba(26,28,32,0)");
    ctx.fillStyle = ob;
    ctx.fillRect(0, 0, VW, VH * 0.5);
    ctx.restore();

    const s = sunPos();
    // a dim sun smothered by smog — weak, hazy glow
    const rg = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, VW * 0.5);
    rg.addColorStop(0, `rgba(232,210,168,${0.34 * (1 - t * 0.5)})`);
    rg.addColorStop(0.18, "rgba(210,180,140,0.12)");
    rg.addColorStop(1, "rgba(210,180,140,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, VW, VH);

    // faint crepuscular rays cutting through the murk
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rays = 7;
    const drift = Math.sin(now() * 0.06) * 0.03;
    for (let i = 0; i < rays; i++) {
      const ang = Math.PI * 0.52 + (i - rays / 2) * 0.16 + drift + (hash(i) - 0.5) * 0.05;
      const len = VH * 1.4;
      const w = 0.04 + hash(i * 7) * 0.02;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(ang - w) * len, s.y + Math.sin(ang - w) * len);
      ctx.lineTo(s.x + Math.cos(ang + w) * len, s.y + Math.sin(ang + w) * len);
      ctx.closePath();
      ctx.fillStyle = `rgba(220,196,150,${0.03 * (1 - t * 0.6)})`;
      ctx.fill();
    }
    ctx.restore();

    // wan, washed-out sun disc behind the haze
    ctx.save();
    ctx.fillStyle = "rgba(226,210,176,0.7)";
    ctx.beginPath();
    ctx.arc(s.x, s.y, 26, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // A shattered treeline silhouette along the horizon (parallax with the ridge).
  function drawTreeline() {
    const horizon = worldToScreen(0, 0).y;
    if (horizon > VH + 30) return;
    const par = 0.5 * cam.zoom;
    const spacing = 46;
    const left = cam.x + (-60 - VW * 0.4) / par;
    const right = cam.x + (VW + 60 - VW * 0.4) / par;
    ctx.save();
    ctx.strokeStyle = "rgba(28,32,30,0.6)";
    ctx.fillStyle = "rgba(28,32,30,0.55)";
    for (let c = Math.floor(left / spacing); c <= Math.ceil(right / spacing); c++) {
      const h = hash(c * 13 + 5);
      if (h < 0.45) continue; // sparse, broken stumps
      const wx = c * spacing + (hash(c * 31) - 0.5) * spacing * 0.6;
      const sx = (wx - cam.x) * par + VW * 0.4;
      const th = (10 + hash(c * 17) * 22) * cam.zoom; // trunk height
      const lean = (hash(c * 5) - 0.5) * 4 * cam.zoom;
      ctx.lineWidth = Math.max(1, 1.6 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(sx, horizon);
      ctx.lineTo(sx + lean, horizon - th);
      ctx.stroke();
      // a couple of broken branch stubs
      if (h > 0.7) {
        ctx.beginPath();
        ctx.moveTo(sx + lean * 0.6, horizon - th * 0.6);
        ctx.lineTo(sx + lean * 0.6 + 4 * cam.zoom, horizon - th * 0.72);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Distant battlefield smoke columns rising from the horizon.
  function drawSmokeColumns() {
    const horizon = worldToScreen(0, 0).y;
    if (horizon > VH + 20) return;
    const par = 0.34 * cam.zoom;
    const spacing = 560;
    const left = cam.x + (-120 - VW * 0.4) / par;
    const right = cam.x + (VW + 120 - VW * 0.4) / par;
    const T = now();
    ctx.save();
    for (let c = Math.floor(left / spacing); c <= Math.ceil(right / spacing); c++) {
      if (hash(c * 91 + 3) < 0.4) continue; // denser than before
      const wx = c * spacing + (hash(c * 7) - 0.5) * spacing * 0.7;
      const sx = (wx - cam.x) * par + VW * 0.4;
      if (sx < -120 || sx > VW + 120) continue;
      const tall = (70 + hash(c * 23) * 130) * cam.zoom;
      const puffs = 9;
      for (let i = 0; i < puffs; i++) {
        const f = i / puffs;
        const drift = Math.sin(T * 0.3 + c + i * 0.5) * (6 + i * 2.6) * cam.zoom;
        const py = horizon - f * tall;
        const pr = (4 + i * 2.6) * cam.zoom;
        const shade = 30 - i * 2;
        ctx.fillStyle = `rgba(${shade},${shade - 2},${shade},${0.42 * (1 - f * 0.85)})`;
        ctx.beginPath();
        ctx.arc(sx + drift, py, pr, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawHills() {
    // distant parallax ridge line
    const par = 0.25 * cam.zoom;
    const baseY = worldToScreen(0, 0).y;
    ctx.save();
    ctx.fillStyle = "#5b7a86";
    ctx.beginPath();
    ctx.moveTo(0, VH);
    for (const h of hills) {
      const sx = (h.x - cam.x) * par + VW * 0.4;
      const peakY = baseY - h.h * par * 1.4;
      ctx.lineTo(sx, peakY);
      ctx.lineTo(sx + h.w * par, baseY);
    }
    ctx.lineTo(VW, VH);
    ctx.closePath();
    ctx.fill();

    // a second, nearer ridge
    ctx.fillStyle = "#4a6b5a";
    const par2 = 0.5 * cam.zoom;
    ctx.beginPath();
    ctx.moveTo(0, VH);
    for (const h of hills) {
      const sx = (h.x * 1.3 - cam.x) * par2 + VW * 0.4;
      const peakY = baseY - h.h * 0.7 * par2;
      ctx.lineTo(sx, peakY);
      ctx.lineTo(sx + h.w * 0.7 * par2, baseY);
    }
    ctx.lineTo(VW, VH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawClouds() {
    for (const c of clouds) {
      const sx = (c.x - cam.x * c.depth) * cam.zoom + VW * 0.4;
      const sy = (c.y - cam.y) * cam.zoom + VH * 0.58;
      if (sx < -200 || sx > VW + 200) continue;
      const r = 26 * c.s * cam.zoom;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      puff(sx, sy, r);
      ctx.restore();
    }
  }
  function puff(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.arc(x + r, y + r * 0.2, r * 0.8, 0, TAU);
    ctx.arc(x - r, y + r * 0.2, r * 0.8, 0, TAU);
    ctx.arc(x + r * 0.4, y - r * 0.5, r * 0.7, 0, TAU);
    ctx.fill();
  }

  function drawGround() {
    const horizon = worldToScreen(0, 0).y;
    if (horizon > VH) return;
    // churned, war-worn field under an overcast sky — muddy olive, going dark
    const g = ctx.createLinearGradient(0, horizon, 0, VH);
    g.addColorStop(0, "#4e6536");
    g.addColorStop(0.5, "#3f522b");
    g.addColorStop(1, "#283a1d");
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, VW, VH - horizon);

    // mud / shell-churn patches scattered across the field
    const mudSpacing = 120;
    const mLeft = cam.x - VW / cam.zoom;
    for (let c = Math.floor(mLeft / mudSpacing); c < (cam.x + VW / cam.zoom) / mudSpacing; c++) {
      const h = hash(c * 41 + 9);
      if (h < 0.4) continue;
      const wx = c * mudSpacing + (hash(c * 3) - 0.5) * mudSpacing;
      const s = worldToScreen(wx, 0);
      if (s.x < -120 || s.x > VW + 120) continue;
      const w = (24 + hash(c * 5) * 46) * cam.zoom;
      ctx.fillStyle = `rgba(74,58,38,${0.16 + h * 0.16})`;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + (6 + hash(c * 11) * 16) * cam.zoom, w, w * 0.4, 0, 0, TAU);
      ctx.fill();
    }

    // runway near origin (the aerodrome)
    drawRunway(horizon);

    // texture stripes (furrows) that scroll with the world
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = Math.max(1, 2 * cam.zoom);
    const spacing = 70;
    const startWorld = cam.x - VW / cam.zoom;
    const first = Math.floor(startWorld / spacing) * spacing;
    for (let wx = first; wx < cam.x + VW / cam.zoom; wx += spacing) {
      const s = worldToScreen(wx, 0);
      ctx.beginPath();
      ctx.moveTo(s.x, horizon);
      ctx.lineTo(s.x - 30 * cam.zoom, VH);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRunway(horizon) {
    const a = worldToScreen(-180, 0);
    const b = worldToScreen(420, 0);
    if (b.x < 0 || a.x > VW) return;
    ctx.save();
    ctx.fillStyle = "#b9a07a";
    ctx.fillRect(a.x, horizon, b.x - a.x, Math.max(6, 10 * cam.zoom));
    // dashed centerline
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = Math.max(1, 2 * cam.zoom);
    ctx.setLineDash([14 * cam.zoom, 12 * cam.zoom]);
    ctx.beginPath();
    ctx.moveTo(a.x, horizon + 5 * cam.zoom);
    ctx.lineTo(b.x, horizon + 5 * cam.zoom);
    ctx.stroke();
    ctx.restore();
  }

  // Procedural battlefield scenery on the ground: craters, sandbag trenches,
  // splintered trees, barbed wire and fires. World-locked and zoom-scaled, and
  // suppressed over the friendly aerodrome so the runway stays clear.
  function drawBattlefield() {
    const horizon = worldToScreen(0, 0).y;
    if (horizon > VH + 40) return;
    const z = cam.zoom;
    const spacing = 150;
    const left = cam.x - VW / z;
    const right = cam.x + VW / z;
    const T = now();
    for (let c = Math.floor(left / spacing); c <= Math.ceil(right / spacing); c++) {
      const wx = c * spacing + (hash(c * 19) - 0.5) * spacing * 0.7;
      if (wx > -520 && wx < 520) continue; // keep the aerodrome clear
      const s = worldToScreen(wx, 0);
      if (s.x < -160 || s.x > VW + 160) continue;
      const pick = hash(c * 101 + 7);
      ctx.save();
      ctx.translate(s.x, s.y);
      if (pick < 0.22) fCrater(z, hash(c * 2));
      else if (pick < 0.40) fTrench(z, hash(c * 9));
      else if (pick < 0.57) fDeadTree(z, hash(c * 6), hash(c * 15));
      else if (pick < 0.69) fWire(z);
      else if (pick < 0.77) fFire(z, c, T);
      else if (pick < 0.90) fPuddle(z, hash(c * 4));
      // else: bare, churned ground
      ctx.restore();
    }
  }

  function fCrater(z, seed) {
    const w = (34 + seed * 40) * z;
    ctx.fillStyle = "rgba(58,46,32,0.55)";
    ctx.beginPath();
    ctx.ellipse(0, 3 * z, w, 8 * z, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(34,27,18,0.6)";
    ctx.beginPath();
    ctx.ellipse(0, 3 * z, w * 0.66, 5 * z, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(96,80,54,0.5)";
    ctx.lineWidth = 1.4 * z;
    ctx.beginPath();
    ctx.ellipse(0, 1.5 * z, w, 8 * z, 0, Math.PI * 1.04, Math.PI * 1.96);
    ctx.stroke();
  }

  function fTrench(z, seed) {
    // a low sandbag parapet with a dark trench gap and a wooden post
    const n = 4 + Math.floor(seed * 3);
    ctx.fillStyle = "rgba(20,18,14,0.55)";
    ctx.fillRect(-6 * z, -2 * z, 12 * z, 12 * z); // trench mouth
    for (let i = 0; i < n; i++) {
      const bx = (-n / 2 + i) * 11 * z;
      ctx.fillStyle = i % 2 ? "#7d6e4c" : "#8b7c58";
      ctx.beginPath();
      ctx.ellipse(bx, -3 * z, 6.5 * z, 4.5 * z, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(40,33,22,0.5)";
      ctx.lineWidth = 0.8 * z;
      ctx.stroke();
    }
    ctx.fillStyle = "#5a4327";
    ctx.fillRect(-1.2 * z, -16 * z, 2.4 * z, 14 * z); // revetment post
  }

  function fDeadTree(z, seed, seed2) {
    const h = (26 + seed * 30) * z;
    const lean = (seed2 - 0.5) * 7 * z;
    ctx.strokeStyle = "#3a3026";
    ctx.lineCap = "round";
    ctx.lineWidth = 2.4 * z;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(lean * 0.5, -h * 0.6, lean, -h); // splintered, leaning trunk
    ctx.stroke();
    // a few broken limbs
    ctx.lineWidth = 1.4 * z;
    const limbs = 2 + Math.floor(seed * 2);
    for (let i = 0; i < limbs; i++) {
      const ly = -h * (0.4 + 0.5 * (i / limbs));
      const dir = i % 2 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(lean * (0.4 + 0.5 * (i / limbs)), ly);
      ctx.lineTo(lean * 0.5 + dir * (7 + seed * 6) * z, ly - (3 + seed * 4) * z);
      ctx.stroke();
    }
  }

  function fPuddle(z, seed) {
    // muddy shell-hole water with a wan sky reflection
    const w = (16 + seed * 26) * z;
    ctx.fillStyle = "rgba(30,34,30,0.5)";
    ctx.beginPath();
    ctx.ellipse(0, 4 * z, w * 1.1, 5 * z, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(120,130,128,0.4)";
    ctx.beginPath();
    ctx.ellipse(0, 4 * z, w * 0.8, 3 * z, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(170,176,170,0.28)";
    ctx.beginPath();
    ctx.ellipse(-w * 0.2, 3.4 * z, w * 0.4, 1.4 * z, 0, 0, TAU);
    ctx.fill();
  }

  function fWire(z) {
    // posts with sagging barbed wire
    ctx.strokeStyle = "#4a4034";
    ctx.lineWidth = 1.6 * z;
    const span = 26 * z;
    for (const px of [-span / 2, span / 2]) {
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, -10 * z);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(70,64,54,0.85)";
    ctx.lineWidth = 0.8 * z;
    for (const yy of [-8 * z, -4 * z]) {
      ctx.beginPath();
      ctx.moveTo(-span / 2, yy);
      ctx.quadraticCurveTo(0, yy + 4 * z, span / 2, yy);
      ctx.stroke();
    }
    // barbs
    ctx.fillStyle = "rgba(70,64,54,0.85)";
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect(i * 5 * z - 0.5 * z, -6.5 * z, 1 * z, 3 * z);
    }
  }

  function fFire(z, c, T) {
    const flick = 0.7 + 0.3 * Math.sin(T * 9 + c);
    // glow
    ctx.fillStyle = `rgba(255,150,60,${0.18 * flick})`;
    ctx.beginPath();
    ctx.ellipse(0, -4 * z, 16 * z, 12 * z, 0, 0, TAU);
    ctx.fill();
    // flames
    for (let i = -1; i <= 1; i++) {
      const fh = (12 + (i === 0 ? 8 : 0)) * z * flick;
      ctx.fillStyle = i === 0 ? "#ffd24a" : "#ff7a33";
      ctx.beginPath();
      ctx.moveTo(i * 4 * z - 3 * z, 0);
      ctx.quadraticCurveTo(i * 4 * z, -fh, i * 4 * z + 1 * z, 0);
      ctx.closePath();
      ctx.fill();
    }
    // rising smoke
    for (let i = 0; i < 4; i++) {
      const f = i / 4;
      ctx.fillStyle = `rgba(40,38,38,${0.28 * (1 - f)})`;
      ctx.beginPath();
      ctx.arc(Math.sin(T * 0.8 + i) * 4 * z, -(14 + i * 9) * z, (3 + i * 2) * z, 0, TAU);
      ctx.fill();
    }
  }

  function drawTargets() {
    for (const t of targets) {
      const s = worldToScreen(t.x, 0);
      if (s.x < -200 || s.x > VW + 200) continue;
      const z = cam.zoom;
      ctx.save();
      ctx.translate(s.x, s.y);
      if (t.destroyed) {
        drawRubble(t, z);
      } else {
        switch (t.type) {
          case "aa": drawAA(t, z); break;
          case "truck": drawTruck(t, z); break;
          case "tent": drawTent(t, z); break;
          case "depot": drawDepot(t, z); break;
          case "hangar": drawHangar(t, z); break;
          default: drawTent(t, z);
        }
      }
      ctx.restore();
    }
  }

  function drawRubble(t, z) {
    ctx.fillStyle = "#3a3a3a";
    for (let i = 0; i < 5; i++) {
      const w = (t.w / 5) * z;
      ctx.fillRect((-t.w / 2 + i * (t.w / 5)) * z, -rand(4, 10) * z, w * 0.8, 8 * z);
    }
  }
  function drawTent(t, z) {
    ctx.fillStyle = "#7e7a55";
    ctx.beginPath();
    ctx.moveTo(-t.w / 2 * z, 0);
    ctx.lineTo(0, -t.h * z);
    ctx.lineTo(t.w / 2 * z, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#5f5c40";
    ctx.fillRect(-3 * z, -t.h * z, 6 * z, t.h * z);
  }
  function drawTruck(t, z) {
    ctx.fillStyle = "#4d5a3a";
    ctx.fillRect(-t.w / 2 * z, -t.h * 0.7 * z, t.w * 0.62 * z, t.h * 0.7 * z);
    ctx.fillStyle = "#3a4530";
    ctx.fillRect((t.w * 0.12) * z, -t.h * z, t.w * 0.28 * z, t.h * z);
    ctx.fillStyle = "#222";
    circle((-t.w * 0.28) * z, 0, 7 * z);
    circle((t.w * 0.22) * z, 0, 7 * z);
  }
  function drawDepot(t, z) {
    ctx.fillStyle = "#6a5a44";
    ctx.fillRect(-t.w / 2 * z, -t.h * z, t.w * z, t.h * z);
    ctx.fillStyle = "#4d4030";
    for (let i = 0; i < 4; i++)
      ctx.fillRect((-t.w / 2 + 8 + i * (t.w / 4)) * z, -t.h * 0.8 * z, 10 * z, t.h * 0.6 * z);
    ctx.fillStyle = "#3a3025";
    ctx.fillRect(-t.w / 2 * z, -t.h * z, t.w * z, 8 * z);
  }
  function drawHangar(t, z) {
    ctx.fillStyle = "#586068";
    ctx.beginPath();
    ctx.moveTo(-t.w / 2 * z, 0);
    ctx.lineTo(-t.w / 2 * z, -t.h * 0.5 * z);
    ctx.quadraticCurveTo(0, -t.h * 1.15 * z, t.w / 2 * z, -t.h * 0.5 * z);
    ctx.lineTo(t.w / 2 * z, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#3c4248";
    ctx.fillRect(-t.w * 0.18 * z, -t.h * 0.55 * z, t.w * 0.36 * z, t.h * 0.55 * z);
  }
  function drawAA(t, z) {
    ctx.fillStyle = "#3b3b30";
    ctx.fillRect(-t.w / 2 * z, -t.h * 0.4 * z, t.w * z, t.h * 0.4 * z);
    // barrel aimed at the player
    ctx.save();
    const ang = Math.atan2(player.y - -t.h, player.x - t.x);
    ctx.translate(0, -t.h * 0.4 * z);
    ctx.rotate(ang);
    ctx.fillStyle = "#26261e";
    ctx.fillRect(0, -4 * z, t.h * 0.9 * z, 8 * z);
    ctx.restore();
    ctx.fillStyle = "#2c2c22";
    circle(0, -t.h * 0.4 * z, 9 * z);
  }

  function drawBombs() {
    for (const b of bombs) {
      const s = worldToScreen(b.x, b.y);
      const z = cam.zoom;
      const ang = Math.atan2(b.vy, b.vx);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(ang);
      ctx.fillStyle = "#2b2b2b";
      ctx.beginPath();
      ctx.ellipse(0, 0, 8 * z, 4 * z, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#555";
      ctx.beginPath();
      ctx.moveTo(-8 * z, 0);
      ctx.lineTo(-13 * z, -4 * z);
      ctx.lineTo(-13 * z, 4 * z);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBullets() {
    for (const b of bullets) {
      const s = worldToScreen(b.x, b.y);
      const z = cam.zoom;
      ctx.fillStyle = b.from === "player" ? "#fff1a0" : "#ff6a4a";
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.5, 2.4 * z), 0, TAU);
      ctx.fill();
      // tracer tail
      ctx.strokeStyle = b.from === "player" ? "rgba(255,241,160,0.5)" : "rgba(255,106,74,0.5)";
      ctx.lineWidth = Math.max(1, 1.6 * z);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - b.vx * 0.02 * z, s.y - b.vy * 0.02 * z);
      ctx.stroke();
    }
  }

  function drawEnemies() {
    for (const e of enemies) {
      const s = worldToScreen(e.x, e.y);
      if (s.x < -120 || s.x > VW + 120) continue;
      drawPlane(s.x, s.y, e.pitch, e.dir, cam.zoom, true, e.hp);
    }
  }

  function drawPlayer() {
    const s = worldToScreen(player.x, player.y);
    const blink = player.invuln > 0 && Math.floor(now() * 16) % 2 === 0;
    if (!blink) {
      // flipX stays +1 (heading sets the facing); rollAnim is the vertical flip
      // that rolls the plane upside-down/upright through a knife-edge at 0.
      drawPlane(s.x, s.y, player.pitch, 1, cam.zoom, false, player.hp, 1, player.rollAnim);
    }
  }

  /* A detailed side-view biplane modelled on the Sopwith Camel B6313:
     silver rotary cowl, wooden prop, PC10 khaki airframe, RAF roundels and a
     blue/white/red striped rudder. Enemies reuse the shape in red with crosses.
     Drawn in fixed "model units"; the context is scaled by the camera zoom so
     line weights and detail scale naturally. Nose points +x (right). */
  function drawPlane(sx, sy, pitchDeg, dir, zoom, enemy, hp, flipX, squashY) {
    if (flipX === undefined) flipX = dir; // visual horizontal scale (banking turn)
    if (squashY === undefined) squashY = 1; // vertical squash while rolling
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(flipX, squashY); // face left/right + bank-through-zero on a turn
    ctx.rotate(-pitchDeg * DEG * dir); // pitch — any angle, so full loops read right
    const s = zoom * 0.9;
    ctx.scale(s, s);
    ctx.lineJoin = "round";

    const P = enemy
      ? { body: "#a83a2e", bodyDk: "#7d271d", wing: "#b04035", wingDk: "#822c22",
          cowl: "#5d5d61", cowlHi: "#86868a", prop: "#6f5230", strut: "#43291d" }
      : { body: "#736c3b", bodyDk: "#544e29", wing: "#7c7647", wingDk: "#565132",
          cowl: "#b9bdc1", cowlHi: "#e2e6e9", prop: "#9c6b34", strut: "#5a4327" };
    const line = "rgba(20,18,12,0.5)";

    // ---- horizontal stabilizer ----
    ctx.fillStyle = P.wingDk;
    ctx.beginPath();
    ctx.moveTo(-21, -1); ctx.lineTo(-34, -3.2); ctx.lineTo(-34, 2.4); ctx.lineTo(-21, 2);
    ctx.closePath(); ctx.fill();

    // ---- vertical fin + rudder (tricolor for the Camel) ----
    ctx.beginPath();
    ctx.moveTo(-24, 2.2);
    ctx.lineTo(-25.5, -11);
    ctx.quadraticCurveTo(-29, -13, -32, -10.5);
    ctx.lineTo(-34, 2.2);
    ctx.closePath();
    if (enemy) {
      ctx.fillStyle = P.bodyDk; ctx.fill();
    } else {
      ctx.save(); ctx.clip();
      ctx.fillStyle = "#f4f4f4"; ctx.fillRect(-35, -14, 13, 18); // white base
      ctx.fillStyle = "#11317a"; ctx.fillRect(-27, -14, 5, 18); // blue, fuselage side
      ctx.fillStyle = "#c8102e"; ctx.fillRect(-35, -14, 3.4, 18); // red, trailing edge
      ctx.restore();
    }
    ctx.lineWidth = 0.5; ctx.strokeStyle = line; ctx.stroke();

    // ---- lower wing ----
    roundRect(-14, 5.4, 30, 2.7, 1.2); ctx.fillStyle = P.wing; ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.12)"; ctx.fillRect(-14, 7.4, 30, 0.7);

    // ---- landing gear ----
    ctx.lineCap = "round";
    ctx.strokeStyle = P.strut; ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-1, 5); ctx.lineTo(1.5, 14);
    ctx.moveTo(9, 5); ctx.lineTo(5, 14);
    ctx.stroke();
    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0.5, 14); ctx.lineTo(6, 14); ctx.stroke(); // axle
    ctx.fillStyle = "#1c1c1c"; circle(3.2, 14.2, 3.6); // tyre
    ctx.fillStyle = "#7d7f82"; circle(3.2, 14.2, 1.5); // hub

    // ---- fuselage ----
    ctx.beginPath();
    ctx.moveTo(-24, -2);
    ctx.lineTo(-4, -5);
    ctx.lineTo(8, -5);
    ctx.lineTo(13, -3.6);
    ctx.lineTo(13.5, 5);
    ctx.lineTo(-24, 2.2);
    ctx.closePath();
    ctx.fillStyle = P.body; ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.14)"; ctx.fillRect(-24, 1.2, 37.5, 1.1); // belly shadow
    ctx.lineWidth = 0.5; ctx.strokeStyle = line; ctx.stroke();

    // ---- cowl (rotary engine cowling) ----
    ctx.fillStyle = P.cowl;
    ctx.beginPath(); ctx.ellipse(15.5, 0, 5, 6.1, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.ellipse(16.5, 0, 3.7, 5, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.beginPath(); ctx.ellipse(17, 0, 2.6, 3.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = P.cowlHi;
    ctx.beginPath(); ctx.ellipse(13.6, -2, 1.4, 2.6, 0, 0, TAU); ctx.fill();

    // ---- propeller ----
    ctx.fillStyle = "rgba(120,90,50,0.22)"; // motion blur
    ctx.beginPath(); ctx.ellipse(20.5, 0, 2.8, 7.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = P.prop; // wooden blade
    ctx.beginPath(); ctx.ellipse(20.5, 0, 1.15, 7.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "rgba(255,235,200,0.5)";
    ctx.beginPath(); ctx.ellipse(20.2, -3, 0.5, 2.2, 0, 0, TAU); ctx.fill();

    // ---- cabane + interplane struts ----
    ctx.strokeStyle = P.strut; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-11, -10.5); ctx.lineTo(-11, 5.6); // rear interplane strut
    ctx.moveTo(12, -10.5); ctx.lineTo(12, 5.6); // front interplane strut
    ctx.moveTo(-1, -5); ctx.lineTo(0, -11); // cabane
    ctx.moveTo(4, -5); ctx.lineTo(4, -11);
    ctx.stroke();
    ctx.strokeStyle = "rgba(230,230,230,0.35)"; ctx.lineWidth = 0.4; // rigging wires
    ctx.beginPath();
    ctx.moveTo(-11, 5.6); ctx.lineTo(12, -10.5);
    ctx.moveTo(12, 5.6); ctx.lineTo(-11, -10.5);
    ctx.stroke();

    // ---- upper wing ----
    roundRect(-16, -13.6, 33, 3, 1.4); ctx.fillStyle = P.wing; ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(-16, -13.6, 33, 0.7);
    ctx.fillStyle = "rgba(0,0,0,0.14)"; ctx.fillRect(-16, -11.3, 33, 0.6);

    // ---- cockpit + pilot ----
    ctx.fillStyle = "#241f17";
    ctx.beginPath(); ctx.ellipse(-3, -5, 2.3, 1.9, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = "#6b4a32"; circle(-3, -5.7, 1.3); // head
    ctx.fillStyle = "#1a1a1a"; ctx.fillRect(-4.2, -6.1, 2.4, 0.7); // helmet/goggles

    // ---- national markings ----
    if (enemy) {
      drawCross(-7, 0, 3); // fuselage
      drawCross(1, -12.1, 3); // upper wing
    } else {
      drawRoundel(-7, 0, 2.7); // fuselage
      drawRoundel(1, -12.1, 2.5); // upper wing
    }

    ctx.restore();
  }

  function drawRoundel(x, y, r) {
    ctx.fillStyle = "#11317a"; circle(x, y, r);
    ctx.fillStyle = "#f4f4f4"; circle(x, y, r * 0.62);
    ctx.fillStyle = "#c8102e"; circle(x, y, r * 0.3);
  }

  function drawCross(x, y, r) {
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(x - r, y - r * 0.34, 2 * r, r * 0.68);
    ctx.fillRect(x - r * 0.34, y - r, r * 0.68, 2 * r);
    ctx.fillStyle = "#141414";
    const i = r * 0.66;
    ctx.fillRect(x - i, y - i * 0.34, 2 * i, i * 0.68);
    ctx.fillRect(x - i * 0.34, y - i, i * 0.68, 2 * i);
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawParticles() {
    for (const p of particles) {
      const s = worldToScreen(p.x, p.y);
      const a = clamp(p.life / p.maxLife, 0, 1);
      if (p.ring) {
        ctx.save();
        ctx.globalAlpha = a * 0.6;
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 3 * cam.zoom;
        ctx.beginPath();
        ctx.arc(s.x, s.y, p.r * cam.zoom, 0, TAU);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.5, p.r * cam.zoom), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */
  const hudAlt = document.getElementById("hud-alt");
  const hudSpd = document.getElementById("hud-spd");
  const hudScore = document.getElementById("hud-score");
  const hudBombs = document.getElementById("hud-bombs");
  const hudMission = document.getElementById("hud-mission");
  const hudObjective = document.getElementById("hud-objective");
  const healthFill = document.getElementById("health-fill");

  function updateHUD(alt) {
    hudAlt.textContent = Math.round(alt);
    hudSpd.textContent = Math.round(player.speed * 0.6);
    hudScore.textContent = score;
    hudBombs.textContent = player.bombs;
    healthFill.style.width = clamp(player.hp, 0, 100) + "%";
    hudMission.textContent = mission.title;
    const what =
      mission.type === "bombing"
        ? "targets bombed"
        : mission.type === "dogfight"
        ? "planes downed"
        : "targets destroyed";
    hudObjective.textContent = `${missionProgress} / ${mission.goal} ${what}`;
  }

  /* ------------------------------------------------------------------ *
   * Screens / flow
   * ------------------------------------------------------------------ */
  const screens = {
    menu: document.getElementById("menu"),
    howto: document.getElementById("howto"),
    pause: document.getElementById("pause-screen"),
    briefing: document.getElementById("briefing"),
    result: document.getElementById("result"),
  };
  const pauseBtn = document.getElementById("btn-pause");

  function hideAllScreens() {
    Object.values(screens).forEach((s) => s.classList.add("hidden"));
  }
  function showScreen(name) {
    hideAllScreens();
    if (screens[name]) screens[name].classList.remove("hidden");
    pauseBtn.style.display = state === STATE.PLAY ? "block" : "none";
  }

  function showBriefing() {
    state = STATE.BRIEF;
    document.getElementById("brief-title").textContent = mission.title;
    document.getElementById("brief-text").textContent = mission.brief;
    showScreen("briefing");
  }

  function beginPlay() {
    state = STATE.PLAY;
    hideAllScreens();
    pauseBtn.style.display = "block";
  }

  function togglePause() {
    if (state === STATE.PLAY) {
      state = STATE.PAUSE;
      showScreen("pause");
    } else if (state === STATE.PAUSE) {
      beginPlay();
    }
  }

  // Buttons
  document.getElementById("btn-start").addEventListener("click", () => startMission(0));
  document.getElementById("btn-howto").addEventListener("click", () => showScreen("howto"));
  document.getElementById("btn-howto-back").addEventListener("click", () => showScreen("menu"));
  document.getElementById("btn-brief-go").addEventListener("click", beginPlay);
  document.getElementById("btn-resume").addEventListener("click", beginPlay);
  document.getElementById("btn-quit").addEventListener("click", () => {
    state = STATE.MENU;
    showScreen("menu");
  });
  pauseBtn.addEventListener("click", togglePause);
  document.getElementById("btn-result-next").addEventListener("click", () => {
    const title = document.getElementById("result-title").textContent;
    if (title === "Shot Down") {
      startMission(missionIndex); // retry
    } else if (missionIndex >= MISSIONS.length - 1) {
      score = 0;
      state = STATE.MENU;
      showScreen("menu");
    } else {
      score = score; // keep score across missions
      startMission(missionIndex + 1);
    }
  });

  // stamp the current version onto the home screen
  const versionEl = document.getElementById("version");
  if (versionEl) versionEl.textContent = "v" + VERSION;

  // optional inspection hook for automated tests / debugging (?debug=1)
  if (new URLSearchParams(location.search).get("debug")) {
    window.__SOPWITH = {
      get player() { return player; },
      get enemies() { return enemies; },
      get state() { return state; },
      get mission() { return mission; },
    };
  }

  // start on menu (or jump straight into a mission via ?mission=N for replay/testing)
  const mq = parseInt(new URLSearchParams(location.search).get("mission"), 10);
  if (!isNaN(mq) && mq >= 1 && mq <= MISSIONS.length) {
    startMission(mq - 1);
  } else {
    showScreen("menu");
  }

  /* ------------------------------------------------------------------ *
   * Main loop
   * ------------------------------------------------------------------ */
  let last = now();
  function frame() {
    const t = now();
    let dt = t - last;
    last = t;
    if (dt > 0.05) dt = 0.05; // clamp big stalls

    update(dt);
    render();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
