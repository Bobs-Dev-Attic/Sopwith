/* =====================================================================
 * SOPWITH CAMEL — WWI Flying Ace
 * A mobile-first 2D side-scroller. Self-contained: no assets, no build.
 * Coordinate system: world units, y-DOWN. Ground plane at worldY = 0,
 * sky is negative y. altitude = -worldY (feet, roughly).
 * ===================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Config / tuning
   * ------------------------------------------------------------------ */
  const CFG = {
    // Flight model
    STALL_SPEED: 90,
    CRUISE_SPEED: 165,
    MAX_SPEED: 300,
    SPEED_EASE: 2.2, // how fast speed follows throttle
    PITCH_RATE: 110, // deg/sec while holding an arrow
    PITCH_MAX: 78, // deg
    AUTO_LEVEL: 26, // deg/sec gentle return to level when no input
    GRAVITY: 150, // downward sag when below cruise speed
    CRASH_VY: 230, // vertical speed into ground that hurts

    // Altitude -> zoom mapping
    ZOOM_GROUND: 1.7,
    ZOOM_SKY: 0.6,
    ZOOM_ALT_RANGE: 1500, // alt at which we reach full zoom-out
    ZOOM_EASE: 2.4,
    MAX_ALT: 2200,

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
    pitchUp: false,
    pitchDown: false,
    firing: false,
    throttle: 0.55,
    invert: false,
    bombQueued: false,
  };

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

  const btnUp = document.getElementById("btn-up");
  const btnDown = document.getElementById("btn-down");
  const btnFire = document.getElementById("btn-fire");
  const btnBomb = document.getElementById("btn-bomb");
  const throttleEl = document.getElementById("throttle");

  bindHold(
    btnUp,
    () => (input.pitchUp = true),
    () => (input.pitchUp = false)
  );
  bindHold(
    btnDown,
    () => (input.pitchDown = true),
    () => (input.pitchDown = false)
  );
  bindHold(
    btnFire,
    () => (input.firing = true),
    () => (input.firing = false)
  );
  bindHold(btnBomb, () => (input.bombQueued = true), null);

  throttleEl.addEventListener("input", () => {
    input.throttle = throttleEl.value / 100;
  });
  input.throttle = throttleEl.value / 100;

  // Keyboard (desktop testing / play)
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowUp": input.pitchUp = true; e.preventDefault(); break;
      case "ArrowDown": input.pitchDown = true; e.preventDefault(); break;
      case "ArrowRight":
        input.throttle = clamp(input.throttle + 0.08, 0, 1);
        throttleEl.value = input.throttle * 100; e.preventDefault(); break;
      case "ArrowLeft":
        input.throttle = clamp(input.throttle - 0.08, 0, 1);
        throttleEl.value = input.throttle * 100; e.preventDefault(); break;
      case " ": input.firing = true; e.preventDefault(); break;
      case "b": case "B": input.bombQueued = true; break;
      case "p": case "P": togglePause(); break;
    }
  });
  window.addEventListener("keyup", (e) => {
    switch (e.key) {
      case "ArrowUp": input.pitchUp = false; break;
      case "ArrowDown": input.pitchDown = false; break;
      case " ": input.firing = false; break;
    }
  });

  const invertChk = document.getElementById("invert-pitch");
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
    pitch: 0,
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

  function makeEnemy(x, alt) {
    return {
      x,
      y: -alt,
      pitch: 0,
      vx: 0,
      vy: 0,
      hp: 2,
      speed: rand(130, 185),
      fireCd: rand(0.6, 2.0),
      dir: -1, // facing left toward player by default
      alive: true,
      wobble: rand(0, TAU),
      kind: "fokker",
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
      title: "Mission 1 — Patrol",
      brief:
        "Take off from the aerodrome and clear the skies. Shoot down 4 enemy Fokkers with your Vickers guns.",
      type: "dogfight",
      goal: 4,
      bombs: 0,
      setup() {
        for (let i = 0; i < 3; i++)
          enemies.push(makeEnemy(player.x + rand(700, 1500), rand(300, 700)));
      },
      tick(s) {
        // keep ~3 enemies in the air until the goal's worth has spawned
        if (s.spawned < this.goal && enemies.length < 3 && Math.random() < 0.012) {
          enemies.push(makeEnemy(player.x + rand(900, 1600) * (Math.random() < 0.5 ? 1 : -1), rand(300, 800)));
          s.spawned++;
        }
      },
    },
    {
      title: "Mission 2 — Bombing Run",
      brief:
        "Enemy supply line ahead. Fly low and drop bombs on 5 ground targets. Watch for anti-aircraft guns!",
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
      title: "Mission 3 — All-Out",
      brief:
        "The big push. Destroy 8 targets — planes in the air and installations on the ground. Use guns and bombs.",
      type: "mixed",
      goal: 8,
      bombs: 14,
      setup() {
        let x = player.x + 800;
        const types = ["truck", "aa", "depot", "hangar", "aa", "tent"];
        for (let i = 0; i < 7; i++) {
          targets.push(makeTarget(x, types[i % types.length]));
          x += rand(320, 560);
        }
        for (let i = 0; i < 3; i++)
          enemies.push(makeEnemy(player.x + rand(700, 1600), rand(300, 800)));
      },
      tick(s) {
        if (enemies.length < 3 && Math.random() < 0.01) {
          enemies.push(makeEnemy(player.x + rand(900, 1700) * (Math.random() < 0.5 ? 1 : -1), rand(300, 850)));
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
    missionProgress = 0;
    missionState = { spawned: 0 };

    // reset player on the runway
    player.x = 0;
    player.y = -8;
    player.pitch = 0;
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

    updatePlayer(dt);
    updateWeapons(dt);
    updateEnemies(dt);
    updateTargets(dt);
    updateBombs(dt);
    updateParticles(dt);
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

    // ---- pitch control ----
    let up = input.pitchUp;
    let down = input.pitchDown;
    if (input.invert) {
      const t = up; up = down; down = t;
    }
    if (up) p.pitch += CFG.PITCH_RATE * dt;
    else if (down) p.pitch -= CFG.PITCH_RATE * dt;
    else {
      // gentle auto-level
      if (Math.abs(p.pitch) < CFG.AUTO_LEVEL * dt) p.pitch = 0;
      else p.pitch -= Math.sign(p.pitch) * CFG.AUTO_LEVEL * dt;
    }
    p.pitch = clamp(p.pitch, -CFG.PITCH_MAX, CFG.PITCH_MAX);

    // ---- speed from throttle ----
    const target = CFG.STALL_SPEED + input.throttle * (CFG.MAX_SPEED - CFG.STALL_SPEED);
    p.speed += (target - p.speed) * clamp(CFG.SPEED_EASE * dt, 0, 1);

    // ---- velocity ----
    const pr = p.pitch * DEG;
    let vx = p.speed * Math.cos(pr);
    let vy = -p.speed * Math.sin(pr);
    // gravity sag when below cruise speed (stall)
    const sag = CFG.GRAVITY * Math.max(0, 1 - p.speed / CFG.CRUISE_SPEED);
    vy += sag;

    p.x += vx * dt;
    p.y += vy * dt;

    // ---- altitude clamp / ground interaction ----
    const alt = -p.y;
    p.onGround = false;
    if (alt <= 0) {
      p.y = 0;
      p.onGround = true;
      const descending = vy;
      const tooSteep = p.pitch < -18;
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
    const t = clamp(alt / CFG.ZOOM_ALT_RANGE, 0, 1);
    // ease-out so the zoom change feels smooth near the ground
    const targetZoom = lerp(CFG.ZOOM_GROUND, CFG.ZOOM_SKY, Math.pow(t, 0.75));
    cam.zoom += (targetZoom - cam.zoom) * clamp(CFG.ZOOM_EASE * dt, 0, 1);

    // follow player, look a little ahead in the direction of travel
    const lookAhead = clamp(player.speed * 0.5, 0, 180);
    const tx = player.x + (player.speed >= 0 ? lookAhead : -lookAhead);
    const ty = player.y - 40;
    cam.x += (tx - cam.x) * clamp(6 * dt, 0, 1);
    cam.y += (ty - cam.y) * clamp(5 * dt, 0, 1);

    // keep some ground visible: don't let camera drop too far below horizon
    const maxCamY = 120;
    if (cam.y > maxCamY) cam.y = maxCamY;
  }

  function updateWeapons(dt) {
    const p = player;
    p.fireCd -= dt;
    p.bombCd -= dt;

    if (input.firing && p.fireCd <= 0 && p.alive) {
      p.fireCd = CFG.FIRE_RATE;
      const pr = p.pitch * DEG;
      const dx = Math.cos(pr), dy = -Math.sin(pr);
      const nx = p.x + dx * 22, ny = p.y + dy * 22;
      bullets.push({
        x: nx, y: ny,
        vx: dx * CFG.BULLET_SPEED + Math.cos(pr) * p.speed,
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
        bombs.push({
          x: p.x,
          y: p.y + 8,
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
    for (const e of enemies) {
      if (!e.alive) continue;
      e.wobble += dt * 2;
      // simple AI: match the player's altitude, drift toward them horizontally
      const dy = player.y - e.y;
      const dx = player.x - e.x;
      const desiredPitch = clamp(Math.atan2(-dy, Math.abs(dx) + 1) / DEG, -35, 35);
      e.pitch += (desiredPitch - e.pitch) * clamp(2 * dt, 0, 1);
      e.dir = dx < 0 ? -1 : 1;

      const pr = e.pitch * DEG;
      const heading = e.dir;
      e.x += heading * e.speed * Math.cos(pr) * dt;
      e.y += -Math.sin(pr) * e.speed * dt + Math.sin(e.wobble) * 6 * dt;
      if (-e.y < 30) e.y = -30; // don't fly into the dirt

      // fire at player when roughly aligned and in front
      e.fireCd -= dt;
      const aligned = Math.abs(dy) < 60 && Math.abs(dx) < 700 && Math.sign(dx) === e.dir;
      if (e.fireCd <= 0 && aligned) {
        e.fireCd = rand(0.8, 1.8);
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

      // collision with player
      if (player.invuln <= 0 && Math.hypot(e.x - player.x, e.y - player.y) < 30) {
        damagePlayer(45, true);
        killEnemy(e);
      }

      // cull far behind
      if (Math.abs(e.x - player.x) > 3200) e.alive = false;
    }
    enemies = enemies.filter((e) => e.alive);
  }

  function updateTargets(dt) {
    for (const t of targets) {
      if (t.destroyed || !t.aa) continue;
      t.fireCd -= dt;
      const dx = player.x - t.x;
      const dist = Math.hypot(dx, player.y);
      if (t.fireCd <= 0 && dist < 900 && -player.y > 20) {
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
    drawClouds();
    drawGround();
    drawTargets();
    drawBombs();
    drawEnemies();
    if (player.alive || (Math.floor(now() * 10) % 2 === 0))
      drawPlayer();
    drawBullets();
    drawParticles();
    if (state === STATE.PLAY) updateHUD(alt);
  }

  function drawSky(alt) {
    const t = clamp(alt / CFG.MAX_ALT, 0, 1);
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    // higher = deeper blue
    const top = lerp(0x6db3d6 >> 16 & 255, 0x1c4a73 >> 16 & 255, t);
    g.addColorStop(0, `rgb(${Math.round(lerp(70, 24, t))},${Math.round(lerp(140, 70, t))},${Math.round(lerp(190, 120, t))})`);
    g.addColorStop(0.7, `rgb(${Math.round(lerp(150, 90, t))},${Math.round(lerp(200, 150, t))},${Math.round(lerp(225, 190, t))})`);
    g.addColorStop(1, `rgb(${Math.round(lerp(205, 150, t))},${Math.round(lerp(225, 195, t))},${Math.round(lerp(230, 210, t))})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    // sun
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = "rgba(255,245,200,0.9)";
    ctx.beginPath();
    ctx.arc(VW * 0.82, VH * 0.18, 34, 0, TAU);
    ctx.fill();
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
    // grass field
    const g = ctx.createLinearGradient(0, horizon, 0, VH);
    g.addColorStop(0, "#6fa84a");
    g.addColorStop(1, "#3c6b2c");
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, VW, VH - horizon);

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
    if (!blink) drawPlane(s.x, s.y, player.pitch, 1, cam.zoom, false, player.hp);
  }

  /* The Sopwith Camel (and enemy Fokker) — drawn as a vector biplane. */
  function drawPlane(sx, sy, pitchDeg, dir, z, enemy, hp) {
    ctx.save();
    ctx.translate(sx, sy);
    // dir = 1 faces right, -1 faces left. pitch positive = nose up.
    ctx.scale(dir, 1);
    ctx.rotate(-pitchDeg * DEG * dir);
    z = z * 1.0;

    const body = enemy ? "#a8362c" : "#6f7d3f";
    const bodyDark = enemy ? "#7e261d" : "#535e2c";
    const wing = enemy ? "#c24536" : "#86934a";

    // --- propeller blur ---
    ctx.fillStyle = "rgba(40,40,40,0.45)";
    ctx.beginPath();
    ctx.ellipse(20 * z, 0, 3 * z, 13 * z, 0, 0, TAU);
    ctx.fill();

    // --- lower wing ---
    ctx.fillStyle = wing;
    ctx.fillRect(-15 * z, 6 * z, 34 * z, 4 * z);
    // --- upper wing ---
    ctx.fillRect(-17 * z, -13 * z, 38 * z, 4 * z);
    // --- struts ---
    ctx.strokeStyle = bodyDark;
    ctx.lineWidth = 1.4 * z;
    ctx.beginPath();
    ctx.moveTo(-12 * z, -9 * z); ctx.lineTo(-12 * z, 6 * z);
    ctx.moveTo(14 * z, -9 * z); ctx.lineTo(14 * z, 6 * z);
    ctx.stroke();

    // --- fuselage ---
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-22 * z, 0);
    ctx.lineTo(-14 * z, -5 * z);
    ctx.lineTo(16 * z, -4 * z);
    ctx.lineTo(20 * z, 0);
    ctx.lineTo(16 * z, 4 * z);
    ctx.lineTo(-14 * z, 4 * z);
    ctx.closePath();
    ctx.fill();

    // --- tail ---
    ctx.fillStyle = bodyDark;
    ctx.beginPath();
    ctx.moveTo(-22 * z, 0);
    ctx.lineTo(-30 * z, -8 * z);
    ctx.lineTo(-22 * z, -2 * z);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-30 * z, -1 * z, 9 * z, 3 * z);

    // --- cockpit ---
    ctx.fillStyle = "#2a2a22";
    ctx.beginPath();
    ctx.arc(0, -4 * z, 3 * z, 0, TAU);
    ctx.fill();

    // --- roundel / cross marking ---
    if (enemy) {
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 2 * z;
      ctx.beginPath();
      ctx.moveTo(-4 * z, -13 * z); ctx.lineTo(4 * z, -9 * z);
      ctx.moveTo(4 * z, -13 * z); ctx.lineTo(-4 * z, -9 * z);
      ctx.stroke();
    } else {
      // RAF-style roundel on the upper wing
      ctx.fillStyle = "#0a2a6b";
      circle(2 * z, -11 * z, 3 * z);
      ctx.fillStyle = "#fff";
      circle(2 * z, -11 * z, 2 * z);
      ctx.fillStyle = "#c8102e";
      circle(2 * z, -11 * z, 1 * z);
    }

    ctx.restore();
  }

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
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
