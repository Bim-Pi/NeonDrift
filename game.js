// NEON DRIFT — DeltaHacks Edition
// Single-file canvas arcade runner with juice, powerups, mobile support, and WebAudio SFX.
// No external libraries.

(() => {
  "use strict";

  // ---------- DOM ----------
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { alpha: true });

  const $ = (id) => document.getElementById(id);
  const elScore = $("score");
  const elBest = $("best");
  const elChain = $("chain");
  const overlay = $("overlay");
  const btnPlay = $("btnPlay");
  const btnHow = $("btnHow");
  const btnMute = $("btnMute");
  const how = $("how");
  const toast = $("toast");
  const help = $("help");
  const statusText = $("statusText");
  const statusDot = $("statusDot");

  // ---------- UTIL ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => (a + (Math.random() * (b - a + 1)) | 0);
  const sign = (x) => (x < 0 ? -1 : 1);
  const now = () => performance.now();

  function fmt(n) {
    n = Math.floor(n);
    if (n < 1000) return "" + n;
    if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1e6).toFixed(2).replace(/\.00$/, "") + "m";
  }

  // ---------- CANVAS RESIZE ----------
  const baseW = 1280, baseH = 720;
  function fitCanvas() {
    // Keep internal resolution fixed; CSS scales it for crispness.
    // Optional: adjust for DPR by scaling.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(baseW * dpr);
    canvas.height = Math.floor(baseH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();
  window.addEventListener("resize", fitCanvas);

  // ---------- INPUT ----------
  const input = {
    left: false, right: false,
    boost: false,
    pausePressed: false,
    restartPressed: false,
    helpToggle: false,
    muteToggle: false,
    pointer: { active: false, x: 0, y: 0, lastX: 0, dragging: false },
    twoFingerBoost: false,
  };

  const keyMap = {
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    Space: "boost",
  };

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code in keyMap) {
      input[keyMap[e.code]] = true;
      e.preventDefault();
    }
    if (e.code === "KeyP") { input.pausePressed = true; e.preventDefault(); }
    if (e.code === "KeyR") { input.restartPressed = true; e.preventDefault(); }
    if (e.code === "KeyH") { input.helpToggle = true; e.preventDefault(); }
    if (e.code === "KeyM") { input.muteToggle = true; e.preventDefault(); }
  }, { passive: false });

  window.addEventListener("keyup", (e) => {
    if (e.code in keyMap) {
      input[keyMap[e.code]] = false;
      e.preventDefault();
    }
  }, { passive: false });

  // Pointer / touch
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    input.pointer.active = true;
    input.pointer.dragging = true;
    input.pointer.x = e.offsetX;
    input.pointer.lastX = e.offsetX;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!input.pointer.active) return;
    input.pointer.x = e.offsetX;
  });
  canvas.addEventListener("pointerup", () => {
    input.pointer.active = false;
    input.pointer.dragging = false;
  });
  canvas.addEventListener("pointercancel", () => {
    input.pointer.active = false;
    input.pointer.dragging = false;
  });

  // Two-finger tap boost (mobile)
  let activeTouches = 0;
  window.addEventListener("touchstart", (e) => {
    activeTouches = e.touches.length;
    if (activeTouches >= 2) input.twoFingerBoost = true;
  }, { passive: true });
  window.addEventListener("touchend", (e) => {
    activeTouches = e.touches.length;
    input.twoFingerBoost = false;
  }, { passive: true });

  // ---------- AUDIO (WebAudio) ----------
  let audio = null;
  let muted = false;
  function ensureAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
  }
  function beep(type, freq, dur, gain = 0.08) {
    if (muted) return;
    ensureAudio();
    if (!audio) return;
    const t0 = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audio.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  function noisePop(dur = 0.08, gain = 0.05) {
    if (muted) return;
    ensureAudio();
    if (!audio) return;
    const t0 = audio.currentTime;
    const bufferSize = Math.floor(audio.sampleRate * dur);
    const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const x = i / bufferSize;
      data[i] = (Math.random() * 2 - 1) * (1 - x) * (1 - x);
    }
    const src = audio.createBufferSource();
    const g = audio.createGain();
    g.gain.setValueAtTime(gain, t0);
    src.buffer = buffer;
    src.connect(g);
    g.connect(audio.destination);
    src.start(t0);
  }

  // ---------- GAME STATE ----------
  const LS_BEST = "neondrift_best_v1";
  let best = Number(localStorage.getItem(LS_BEST) || 0);
  elBest.textContent = fmt(best);

  const W = baseW, H = baseH;
  const center = { x: W / 2, y: H / 2 };

  const state = {
    running: false,
    paused: false,
    time: 0,
    dt: 0,
    score: 0,
    chain: 1,
    chainTimer: 0,
    speed: 520,        // forward speed
    targetSpeed: 520,
    difficulty: 0,
    shake: 0,
    vignette: 0.5,
    msg: "",
    msgTimer: 0,

    // powerups
    shield: 0,     // hits remaining
    magnet: 0,     // seconds
    slowmo: 0,     // seconds

    // boost
    energy: 0.35,  // 0..1
    boosting: false,
    boostHeat: 0,  // 0..1 visual
  };

  const player = {
    x: W * 0.2,
    y: H * 0.52,
    r: 18,
    vx: 0,
    vy: 0,
    lane: 0,
    invuln: 0,
    trail: [],
  };

  // Track config
  const track = {
    yTop: H * 0.18,
    yBot: H * 0.86,
    width: W * 0.68,
    x0: W * 0.18,
    x1: W * 0.86,
    wave: 0,
    tilt: 0,
  };

  // Entities
  const hazards = [];
  const orbs = [];
  const fx = [];
  const stars = [];

  // ---------- PARTICLE FX ----------
  function spawnBurst(x, y, colorA, colorB, n = 22, speed = 420) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(speed * 0.25, speed);
      fx.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.35, 0.8),
        t: 0,
        size: rand(1.5, 3.8),
        c1: colorA,
        c2: colorB,
      });
    }
  }

  function spawnText(x, y, text, color="#EAF0FF") {
    fx.push({ kind:"text", x, y, text, color, t:0, life: 0.9, vy: -80 });
  }

  // ---------- SPAWNERS ----------
  let hzTimer = 0;
  let orbTimer = 0;
  let puTimer = 0;

  function spawnHazard() {
    const y = rand(track.yTop + 30, track.yBot - 30);
    const typeRoll = Math.random();
    const kind = typeRoll < 0.70 ? "bar" : (typeRoll < 0.88 ? "spinner" : "mine");
    const size = kind === "bar" ? rand(60, 120) : (kind === "spinner" ? rand(24, 34) : rand(20, 28));
    hazards.push({
      kind,
      x: W + 80,
      y,
      r: size,
      w: size,
      h: kind === "bar" ? rand(16, 22) : size,
      rot: rand(0, Math.PI * 2),
      rotSpd: (kind === "spinner" ? rand(3.5, 6.5) : rand(-1.2, 1.2)),
      vx: -state.speed * rand(0.85, 1.1),
      phase: rand(0, Math.PI * 2),
      amp: kind === "mine" ? rand(18, 40) : 0,
      hits: 1,
    });
  }

  function spawnOrb(cluster=false) {
    const y = rand(track.yTop + 30, track.yBot - 30);
    const base = {
      x: W + 60,
      y,
      r: 10,
      vx: -state.speed * rand(0.92, 1.08),
      value: 18,
      kind: "orb",
      glow: rand(0.6, 1),
    };
    orbs.push(base);
    if (cluster) {
      const n = randi(2, 5);
      for (let i = 0; i < n; i++) {
        orbs.push({
          ...base,
          x: base.x + rand(28, 44) * (i+1),
          y: clamp(base.y + rand(-34, 34), track.yTop+25, track.yBot-25),
          r: rand(8, 11),
          value: randi(10, 18),
          glow: rand(0.45, 1),
        });
      }
    }
  }

  function spawnPowerup() {
    const y = rand(track.yTop + 40, track.yBot - 40);
    const kind = (Math.random() < 0.40) ? "shield" : (Math.random() < 0.65 ? "magnet" : "slowmo");
    orbs.push({
      x: W + 70,
      y,
      r: 14,
      vx: -state.speed * 0.98,
      value: 0,
      kind,
      glow: 1,
    });
  }

  // ---------- STARS / BACKDROP ----------
  function initStars() {
    stars.length = 0;
    for (let i = 0; i < 140; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: rand(0.2, 1),
        tw: rand(0, 1),
      });
    }
  }
  initStars();

  // ---------- COLLISIONS ----------
  function circleHit(ax, ay, ar, bx, by, br) {
    const dx = ax - bx, dy = ay - by;
    const rr = ar + br;
    return dx*dx + dy*dy <= rr*rr;
  }

  function barHit(px, py, pr, hx, hy, hw, hh, rot) {
    // transform player point into hazard local space
    const s = Math.sin(-rot), c = Math.cos(-rot);
    const dx = px - hx, dy = py - hy;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const rx = Math.max(-hw/2, Math.min(hw/2, lx));
    const ry = Math.max(-hh/2, Math.min(hh/2, ly));
    const ox = lx - rx, oy = ly - ry;
    return (ox*ox + oy*oy) <= pr*pr;
  }

  // ---------- GAME FLOW ----------
  function setStatus(text, good=true) {
    statusText.textContent = text;
    statusDot.style.background = good ? "rgba(102,242,255,.9)" : "rgba(255,77,109,.9)";
    statusDot.style.boxShadow = good ? "0 0 18px rgba(102,242,255,.35)" : "0 0 18px rgba(255,77,109,.35)";
  }

  function showToast(text, t=1.35) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    clearTimeout(showToast._tm);
    showToast._tm = setTimeout(() => toast.classList.add("hidden"), t * 1000);
  }

  function reset(run=true) {
    state.running = run;
    state.paused = false;
    state.time = 0;
    state.dt = 0;
    state.score = 0;
    state.chain = 1;
    state.chainTimer = 0;
    state.speed = 520;
    state.targetSpeed = 520;
    state.difficulty = 0;
    state.shake = 0;
    state.msg = "";
    state.msgTimer = 0;

    state.shield = 0;
    state.magnet = 0;
    state.slowmo = 0;
    state.energy = 0.35;
    state.boosting = false;
    state.boostHeat = 0;

    player.x = W * 0.2;
    player.y = H * 0.52;
    player.vx = 0;
    player.vy = 0;
    player.invuln = 0;
    player.trail.length = 0;

    hazards.length = 0;
    orbs.length = 0;
    fx.length = 0;
    initStars();

    hzTimer = 0;
    orbTimer = 0;
    puTimer = 0;

    elScore.textContent = "0";
    elChain.textContent = "x1";
    setStatus("Running", true);
  }

  function gameOver() {
    state.running = false;
    overlay.classList.remove("hidden");
    overlay.style.display = "flex";
    const final = Math.floor(state.score);
    if (final > best) {
      best = final;
      localStorage.setItem(LS_BEST, String(best));
      elBest.textContent = fmt(best);
      showToast("NEW BEST! 🔥 " + fmt(best));
      beep("sawtooth", 680, 0.09, 0.08);
      beep("triangle", 980, 0.11, 0.07);
    } else {
      showToast("Score: " + fmt(final));
      beep("triangle", 220, 0.12, 0.06);
    }
    setStatus("Game Over", false);
  }

  // ---------- UI HANDLERS ----------
  function startGame() {
    overlay.classList.add("hidden");
    overlay.style.display = "none";
    // user gesture enables audio
    ensureAudio();
    if (audio && audio.state === "suspended") audio.resume().catch(()=>{});
    reset(true);
  }

  btnPlay.addEventListener("click", startGame);
  btnHow.addEventListener("click", () => {
    how.classList.toggle("hidden");
  });
  btnMute.addEventListener("click", () => {
    muted = !muted;
    btnMute.textContent = "Sound: " + (muted ? "Off" : "On");
    btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
    showToast(muted ? "Muted" : "Sound on");
  });

  overlay.addEventListener("click", (e) => {
    // clicking outside doesn't start; only Play button
    e.stopPropagation();
  });

  // ---------- RENDER HELP ----------
  function toggleHelp() {
    help.classList.toggle("hidden");
  }

  // ---------- UPDATE LOOP ----------
  let lastT = now();
  function tick() {
    requestAnimationFrame(tick);

    const t = now();
    let dt = (t - lastT) / 1000;
    lastT = t;
    dt = Math.min(0.033, dt); // clamp (avoid huge dt)
    state.dt = dt;

    // global toggles
    if (input.muteToggle) {
      input.muteToggle = false;
      muted = !muted;
      btnMute.textContent = "Sound: " + (muted ? "Off" : "On");
      btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
      showToast(muted ? "Muted" : "Sound on");
    }
    if (input.helpToggle) { input.helpToggle = false; toggleHelp(); }

    if (!state.running) {
      draw();
      // keep subtle background motion even in menu
      state.time += dt;
      return;
    }

    if (input.pausePressed) {
      input.pausePressed = false;
      state.paused = !state.paused;
      setStatus(state.paused ? "Paused" : "Running", !state.paused);
      showToast(state.paused ? "Paused" : "Resumed");
      beep("sine", state.paused ? 300 : 520, 0.07, 0.06);
    }

    if (input.restartPressed) {
      input.restartPressed = false;
      reset(true);
      showToast("Restarted");
      beep("square", 420, 0.06, 0.06);
    }

    if (state.paused) { draw(); return; }

    state.time += dt;

    // Difficulty ramps
    state.difficulty = clamp(state.time / 55, 0, 1);
    state.targetSpeed = 520 + 420 * state.difficulty;
    state.speed = lerp(state.speed, state.targetSpeed, 0.04);

    const slowFactor = state.slowmo > 0 ? 0.62 : 1.0;
    const effectiveSpeed = state.speed * slowFactor;

    // chain decay
    state.chainTimer -= dt;
    if (state.chainTimer <= 0) {
      state.chain = Math.max(1, state.chain - 1);
      state.chainTimer = state.chain > 1 ? 2.0 : 0.0;
      elChain.textContent = "x" + state.chain;
    }

    // powerup timers
    if (state.magnet > 0) state.magnet = Math.max(0, state.magnet - dt);
    if (state.slowmo > 0) state.slowmo = Math.max(0, state.slowmo - dt);
    if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);

    // input -> desired Y movement (drift within track)
    let move = 0;
    if (input.left) move -= 1;
    if (input.right) move += 1;

    // pointer drag affects movement
    if (input.pointer.active) {
      const dx = input.pointer.x - input.pointer.lastX;
      input.pointer.lastX = input.pointer.x;
      move += clamp(dx / 30, -1.7, 1.7);
    }

    // Movement and inertia
    const accel = 2200;
    player.vy += move * accel * dt;
    player.vy *= Math.pow(0.00008, dt); // damping
    player.y += player.vy * dt;
    const pr = player.r;
    player.y = clamp(player.y, track.yTop + pr + 6, track.yBot - pr - 6);

    // Boost (Space or 2-finger)
    input.boost = input.boost || input.twoFingerBoost;
    state.boosting = input.boost && state.energy > 0.02;
    if (state.boosting) {
      state.energy = Math.max(0, state.energy - dt * 0.22);
      state.boostHeat = clamp(state.boostHeat + dt * 2.8, 0, 1);
      // Slight forward assist: hazards move faster toward player
      // (Implemented by scaling their vx during update below)
      if ((state.time * 12 | 0) % 6 === 0) beep("sine", rand(560, 740), 0.03, 0.02);
    } else {
      state.energy = Math.min(1, state.energy + dt * 0.10);
      state.boostHeat = clamp(state.boostHeat - dt * 2.0, 0, 1);
    }

    // Spawn hazards / orbs / powerups
    hzTimer -= dt;
    orbTimer -= dt;
    puTimer -= dt;

    const hzInterval = lerp(0.78, 0.42, state.difficulty);
    const orbInterval = lerp(0.26, 0.18, state.difficulty);

    if (hzTimer <= 0) {
      spawnHazard();
      // occasional double spawn later
      if (state.difficulty > 0.55 && Math.random() < 0.22) {
        spawnHazard();
      }
      hzTimer = hzInterval * rand(0.85, 1.15);
    }
    if (orbTimer <= 0) {
      spawnOrb(Math.random() < 0.35);
      orbTimer = orbInterval * rand(0.8, 1.25);
    }
    if (puTimer <= 0) {
      if (state.time > 8 && Math.random() < 0.35) spawnPowerup();
      puTimer = lerp(10.5, 7.2, state.difficulty) * rand(0.85, 1.25);
    }

    // Update hazards
    const boostScale = state.boosting ? 1.26 : 1.0;
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      h.x += h.vx * dt * (effectiveSpeed / state.speed) * boostScale;
      h.rot += h.rotSpd * dt;
      if (h.kind === "mine") {
        h.y += Math.sin(state.time * 3.0 + h.phase) * h.amp * dt;
        h.y = clamp(h.y, track.yTop+24, track.yBot-24);
      }
      if (h.x < -160) hazards.splice(i, 1);
    }

    // Update orbs & powerups
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      o.x += o.vx * dt * (effectiveSpeed / state.speed) * boostScale;

      // magnet pull
      if (state.magnet > 0 && o.kind === "orb") {
        const dx = player.x - o.x;
        const dy = player.y - o.y;
        const d = Math.hypot(dx, dy);
        if (d < 260) {
          const pull = (1 - d/260) * 1400;
          o.x += (dx / (d+1e-6)) * pull * dt;
          o.y += (dy / (d+1e-6)) * pull * dt;
        }
      }

      if (o.x < -120) orbs.splice(i, 1);
    }

    // Update stars / parallax
    for (const s of stars) {
      s.x -= effectiveSpeed * 0.025 * s.z * dt;
      s.tw += dt * rand(0.2, 0.6);
      if (s.x < -10) { s.x = W + 10; s.y = Math.random() * H; s.z = rand(0.2, 1); s.tw = rand(0, 1); }
    }

    // Update particles
    for (let i = fx.length - 1; i >= 0; i--) {
      const p = fx[i];
      p.t += dt;
      if (p.kind === "text") {
        p.y += p.vy * dt;
        if (p.t > p.life) fx.splice(i, 1);
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= Math.pow(0.06, dt);
        p.vy *= Math.pow(0.06, dt);
        if (p.t > p.life) fx.splice(i, 1);
      }
    }

    // Player trail
    player.trail.push({ x: player.x, y: player.y, t: 0 });
    if (player.trail.length > 28) player.trail.shift();
    for (const tr of player.trail) tr.t += dt;

    // Collisions with orbs / powerups
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      if (circleHit(player.x, player.y, player.r + 6, o.x, o.y, o.r + 2)) {
        if (o.kind === "orb") {
          const add = (o.value + 8) * state.chain;
          state.score += add;
          state.chain = clamp(state.chain + 0.2, 1, 10);
          state.chainTimer = 2.25;
          elChain.textContent = "x" + (state.chain | 0);
          state.energy = clamp(state.energy + 0.10, 0, 1);

          spawnBurst(o.x, o.y, "rgba(102,242,255,.9)", "rgba(179,107,255,.7)", randi(10, 18), 420);
          beep("triangle", rand(720, 920), 0.05, 0.04);
        } else if (o.kind === "shield") {
          state.shield = Math.min(2, state.shield + 1);
          spawnBurst(o.x, o.y, "rgba(102,242,255,.95)", "rgba(65,255,154,.65)", 26, 500);
          spawnText(o.x, o.y - 18, "SHIELD +1", "rgba(102,242,255,.95)");
          beep("sine", 620, 0.07, 0.06);
        } else if (o.kind === "magnet") {
          state.magnet = 7.0;
          spawnBurst(o.x, o.y, "rgba(179,107,255,.9)", "rgba(102,242,255,.65)", 26, 520);
          spawnText(o.x, o.y - 18, "MAGNET!", "rgba(179,107,255,.95)");
          beep("square", 520, 0.07, 0.06);
        } else if (o.kind === "slowmo") {
          state.slowmo = 5.5;
          spawnBurst(o.x, o.y, "rgba(65,255,154,.85)", "rgba(102,242,255,.65)", 26, 520);
          spawnText(o.x, o.y - 18, "SLOW-MO", "rgba(65,255,154,.95)");
          beep("sawtooth", 420, 0.07, 0.06);
        }
        orbs.splice(i, 1);
      }
    }

    // Collisions with hazards
    let hit = false;
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      if (player.invuln > 0) break;
      if (h.kind === "bar") {
        if (barHit(player.x, player.y, player.r, h.x, h.y, h.w, h.h, h.rot)) { hit = true; }
      } else if (h.kind === "spinner") {
        if (circleHit(player.x, player.y, player.r + 6, h.x, h.y, h.r)) { hit = true; }
      } else if (h.kind === "mine") {
        if (circleHit(player.x, player.y, player.r + 4, h.x, h.y, h.r * 0.85)) { hit = true; }
      }

      if (hit) {
        hazards.splice(i, 1);
        break;
      }
    }

    if (hit) {
      if (state.shield > 0) {
        state.shield -= 1;
        player.invuln = 0.55;
        state.shake = 18;
        spawnBurst(player.x, player.y, "rgba(102,242,255,.9)", "rgba(255,204,102,.7)", 32, 560);
        spawnText(player.x, player.y - 22, "BLOCKED!", "rgba(255,204,102,.95)");
        beep("triangle", 260, 0.08, 0.06);
        beep("triangle", 520, 0.06, 0.05);
      } else {
        state.chain = 1;
        state.chainTimer = 0;
        elChain.textContent = "x1";
        player.invuln = 0.85;
        state.shake = 24;
        state.score = Math.max(0, state.score - 180);
        spawnBurst(player.x, player.y, "rgba(255,77,109,.9)", "rgba(179,107,255,.65)", 42, 680);
        spawnText(player.x, player.y - 22, "HIT!", "rgba(255,77,109,.95)");
        noisePop(0.09, 0.05);
        beep("sine", 180, 0.12, 0.08);

        // End game if too early? (keep it arcade: you get 3 hits? but we have shield, so 1-hit to keep tension)
        gameOver();
      }
    }

    // scoring over time (survival)
    state.score += dt * 18 * (1 + state.difficulty * 1.8);
    elScore.textContent = fmt(state.score);

    // camera shake decay
    state.shake = Math.max(0, state.shake - dt * 80);

    draw();
  }

  // ---------- DRAW ----------
  function draw() {
    const shake = state.shake;
    const sx = (Math.random() * 2 - 1) * shake;
    const sy = (Math.random() * 2 - 1) * shake;

    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.translate(sx, sy);

    // background gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(7,10,18,1)");
    g.addColorStop(1, "rgba(11,16,36,1)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars
    for (const s of stars) {
      const a = 0.25 + 0.45 * Math.abs(Math.sin(s.tw));
      ctx.fillStyle = `rgba(234,240,255,${a * s.z})`;
      ctx.fillRect(s.x, s.y, 2*s.z, 2*s.z);
    }

    // track
    drawTrack();

    // hazards
    for (const h of hazards) drawHazard(h);

    // orbs & powerups
    for (const o of orbs) drawOrb(o);

    // player
    drawPlayer();

    // fx
    drawFX();

    // HUD extras (energy bar etc.)
    drawMeters();

    // vignette
    const vg = ctx.createRadialGradient(W/2, H/2, 220, W/2, H/2, 560);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();

    // small status hint when running
    if (state.running && !state.paused) {
      // keep status updated with powerups
      const bits = [];
      if (state.shield > 0) bits.push("Shield:" + state.shield);
      if (state.magnet > 0) bits.push("Magnet");
      if (state.slowmo > 0) bits.push("Slow-mo");
      const txt = bits.length ? ("Active: " + bits.join(" • ")) : "Running";
      statusText.textContent = txt;
    }
  }

  function drawTrack() {
    // moving lane lines
    const y0 = track.yTop, y1 = track.yBot;
    const x0 = track.x0, x1 = track.x1;
    const midX = (x0 + x1) / 2;
    const w = x1 - x0;

    // base track
    ctx.fillStyle = "rgba(7,10,18,.55)";
    roundRect(ctx, x0, y0, w, y1-y0, 22, true, false);

    // border neon
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(43,58,124,.85)";
    roundRect(ctx, x0, y0, w, y1-y0, 22, false, true);

    // inner glow
    ctx.strokeStyle = "rgba(102,242,255,.12)";
    ctx.lineWidth = 10;
    roundRect(ctx, x0+5, y0+5, w-10, (y1-y0)-10, 18, false, true);

    // animated scanlines
    const t = state.time;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    roundRect(ctx, x0+6, y0+6, w-12, (y1-y0)-12, 18, true, false);
    ctx.clip();

    for (let i = 0; i < 18; i++) {
      const yy = y0 + ((t*120 + i*44) % (y1-y0+120)) - 60;
      ctx.fillStyle = i % 2 ? "rgba(179,107,255,.06)" : "rgba(102,242,255,.05)";
      ctx.fillRect(x0, yy, w, 18);
    }

    // lane markers
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(234,240,255,.10)";
    ctx.lineWidth = 2;
    for (let i = 1; i <= 2; i++) {
      const yy = y0 + (i * (y1-y0) / 3);
      dashedLine(x0+16, yy, x1-16, yy, 14, 10, t*220);
    }

    ctx.restore();

    // far glow rails
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "rgba(179,107,255,.10)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(x0+10, y0+8);
    ctx.lineTo(x1-10, y0+8);
    ctx.moveTo(x0+10, y1-8);
    ctx.lineTo(x1-10, y1-8);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawHazard(h) {
    if (h.kind === "bar") {
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      // glow
      ctx.shadowBlur = 18;
      ctx.shadowColor = "rgba(255,77,109,.55)";
      ctx.fillStyle = "rgba(255,77,109,.22)";
      roundRect(ctx, -h.w/2, -h.h/2, h.w, h.h, 10, true, false);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,77,109,.85)";
      ctx.lineWidth = 2;
      roundRect(ctx, -h.w/2, -h.h/2, h.w, h.h, 10, false, true);

      // chevrons
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "rgba(255,204,102,.25)";
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        const x = i * 18;
        ctx.moveTo(x, -h.h/2);
        ctx.lineTo(x + 10, 0);
        ctx.lineTo(x, h.h/2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    if (h.kind === "spinner") {
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      ctx.shadowBlur = 20;
      ctx.shadowColor = "rgba(255,204,102,.55)";
      ctx.strokeStyle = "rgba(255,204,102,.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, h.r, 0, Math.PI*2);
      ctx.stroke();

      // blades
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = "rgba(255,204,102,.18)";
      for (let k = 0; k < 3; k++) {
        ctx.rotate((Math.PI*2)/3);
        roundRect(ctx, h.r*0.2, -5, h.r*0.9, 10, 8, true, false);
      }
      ctx.restore();
      return;
    }

    // mine
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(255,77,109,.55)";
    ctx.fillStyle = "rgba(255,77,109,.15)";
    ctx.beginPath();
    ctx.arc(0, 0, h.r, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,77,109,.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, h.r, 0, Math.PI*2);
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "rgba(234,240,255,.25)";
    for (let k = 0; k < 8; k++) {
      const a = k * (Math.PI*2/8);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*h.r*0.65, Math.sin(a)*h.r*0.65);
      ctx.lineTo(Math.cos(a)*h.r*1.05, Math.sin(a)*h.r*1.05);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOrb(o) {
    let cA = "rgba(102,242,255,.95)";
    let cB = "rgba(179,107,255,.55)";
    let label = null;

    if (o.kind === "shield") { cA = "rgba(102,242,255,.95)"; cB = "rgba(65,255,154,.55)"; label="S"; }
    if (o.kind === "magnet") { cA = "rgba(179,107,255,.95)"; cB = "rgba(102,242,255,.55)"; label="M"; }
    if (o.kind === "slowmo") { cA = "rgba(65,255,154,.95)"; cB = "rgba(102,242,255,.55)"; label="⏱"; }

    ctx.save();
    ctx.translate(o.x, o.y);

    // glow halo
    ctx.shadowBlur = 20;
    ctx.shadowColor = cA;
    const rg = ctx.createRadialGradient(0,0, 2, 0,0, o.r*2.6);
    rg.addColorStop(0, cA);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.6 * o.glow;
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(0,0, o.r*2.2, 0, Math.PI*2);
    ctx.fill();

    // core
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 10;
    ctx.shadowColor = cB;
    ctx.fillStyle = "rgba(234,240,255,.12)";
    ctx.beginPath();
    ctx.arc(0,0, o.r, 0, Math.PI*2);
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = cA;
    ctx.beginPath();
    ctx.arc(0,0, o.r, 0, Math.PI*2);
    ctx.stroke();

    // label for powerups
    if (label) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(234,240,255,.9)";
      ctx.font = "bold 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 0, 1);
    }

    ctx.restore();
  }

  function drawPlayer() {
    // trail
    for (let i = 0; i < player.trail.length; i++) {
      const tr = player.trail[i];
      const a = 1 - (tr.t / 0.45);
      if (a <= 0) continue;
      ctx.globalAlpha = 0.28 * a;
      ctx.fillStyle = state.boosting ? "rgba(255,204,102,.8)" : "rgba(102,242,255,.8)";
      ctx.beginPath();
      ctx.arc(tr.x - tr.t*220, tr.y, player.r * (0.6 + 0.5*a), 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ship
    ctx.save();
    ctx.translate(player.x, player.y);

    // invuln blink
    if (player.invuln > 0 && Math.sin(state.time * 40) > 0.2) ctx.globalAlpha = 0.35;

    // glow
    ctx.shadowBlur = 26;
    ctx.shadowColor = state.boosting ? "rgba(255,204,102,.6)" : "rgba(102,242,255,.55)";
    ctx.fillStyle = "rgba(234,240,255,.10)";
    roundRect(ctx, -22, -14, 44, 28, 14, true, false);
    ctx.shadowBlur = 0;

    // outline
    ctx.strokeStyle = state.boosting ? "rgba(255,204,102,.95)" : "rgba(102,242,255,.95)";
    ctx.lineWidth = 2;
    roundRect(ctx, -22, -14, 44, 28, 14, false, true);

    // cockpit
    const cg = ctx.createLinearGradient(-10, -10, 12, 10);
    cg.addColorStop(0, "rgba(179,107,255,.45)");
    cg.addColorStop(1, "rgba(102,242,255,.20)");
    ctx.fillStyle = cg;
    roundRect(ctx, -10, -8, 20, 16, 10, true, false);

    // shield ring
    if (state.shield > 0) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = "rgba(102,242,255,.7)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, Math.PI*2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function drawFX() {
    for (const p of fx) {
      if (p.kind === "text") {
        const a = 1 - (p.t / p.life);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.font = "900 18px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.fillText(p.text, p.x, p.y);
        ctx.globalAlpha = 1;
        continue;
      }
      const a = 1 - (p.t / p.life);
      ctx.globalAlpha = 0.9 * a;
      const grd = ctx.createLinearGradient(p.x, p.y, p.x - p.vx*0.02, p.y - p.vy*0.02);
      grd.addColorStop(0, p.c1);
      grd.addColorStop(1, p.c2);
      ctx.fillStyle = grd;
      ctx.fillRect(p.x, p.y, p.size, p.size);
      ctx.globalAlpha = 1;
    }
  }

  function drawMeters() {
    // energy bar
    const x = 38, y = 40, w = 240, h = 12;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(8,12,28,.55)";
    roundRect(ctx, x, y, w, h, 10, true, false);
    ctx.strokeStyle = "rgba(43,58,124,.75)";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 10, false, true);

    const ww = w * state.energy;
    const gg = ctx.createLinearGradient(x, y, x+w, y);
    gg.addColorStop(0, "rgba(102,242,255,.95)");
    gg.addColorStop(0.6, "rgba(179,107,255,.85)");
    gg.addColorStop(1, "rgba(255,204,102,.85)");
    ctx.fillStyle = gg;
    roundRect(ctx, x+2, y+2, Math.max(0, ww-4), h-4, 8, true, false);

    // label
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(234,240,255,.75)";
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.fillText("ENERGY", x, y-8);

    // active power icons
    let px = x + w + 18;
    const py = y + h/2;
    if (state.shield > 0) { drawBadge(px, py, "S"+state.shield, "rgba(102,242,255,.95)"); px += 44; }
    if (state.magnet > 0) { drawBadge(px, py, "M", "rgba(179,107,255,.95)"); px += 44; }
    if (state.slowmo > 0) { drawBadge(px, py, "⏱", "rgba(65,255,154,.95)"); px += 44; }

    // paused text
    if (state.paused) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "rgba(234,240,255,.92)";
      ctx.font = "900 44px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", W/2, H/2);
      ctx.font = "700 16px ui-sans-serif, system-ui";
      ctx.fillStyle = "rgba(168,179,214,.95)";
      ctx.fillText("Press P to resume", W/2, H/2 + 36);
      ctx.textAlign = "start";
    }

    ctx.restore();
  }

  function drawBadge(x, y, text, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowBlur = 18;
    ctx.shadowColor = color;
    ctx.fillStyle = "rgba(234,240,255,.08)";
    roundRect(ctx, -16, -14, 32, 28, 12, true, false);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    roundRect(ctx, -16, -14, 32, 28, 12, false, true);
    ctx.fillStyle = "rgba(234,240,255,.9)";
    ctx.font = "900 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 1);
    ctx.restore();
  }

  // ---------- SHAPES ----------
  function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    r = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w, y, r);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function dashedLine(x1, y1, x2, y2, dash=10, gap=8, offset=0) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    let t = (-offset % (dash + gap));
    for (; t < len; t += dash + gap) {
      const a = Math.max(0, t);
      const b = Math.min(len, t + dash);
      ctx.beginPath();
      ctx.moveTo(x1 + ux*a, y1 + uy*a);
      ctx.lineTo(x1 + ux*b, y1 + uy*b);
      ctx.stroke();
    }
  }

  // ---------- START ----------
  overlay.classList.remove("hidden");
  overlay.style.display = "flex";

  // show best
  elBest.textContent = fmt(best);

  // Allow pressing Enter to start
  window.addEventListener("keydown", (e) => {
    if (!state.running && (e.code === "Enter" || e.code === "Space")) {
      startGame();
      e.preventDefault();
    }
  }, { passive:false });

  // start loop
  tick();

})();
