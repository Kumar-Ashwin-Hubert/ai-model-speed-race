import { DESK_ACCENTS, clamp, easeInOut, easeOutCubic, fmtMoney, fmtMs, fmtClock, fmtPercent, fmtTokenTotal } from './util.js';

const WORLD = { w: 1280, h: 720 };

const LANE_W = 400;
const LANE_X0 = 40;
const laneX = (i) => LANE_X0 + i * LANE_W;
const laneCx = (i) => laneX(i) + LANE_W / 2;

const Y = { sign: 96, approver: 188, desk: 218, deskH: 50, mat: 226, window: 304, slot0: 350, slotGap: 36, card: 626 };
const MAX_SLOTS = 7;
const TAU = Math.PI * 2;

const ACCENTS = DESK_ACCENTS;
const C = {
  wall: '#292c2a', wallDark: '#1b1d1c', floorA: '#4f574c', floorB: '#4a5247', line: '#434b41',
  carpet: '#7a6a4f', carpetDark: '#5d4f39', wood: '#8a6a45', woodDark: '#5b4429', woodLight: '#a38055',
  paper: '#efe9d6', ink: '#8b8671', text: '#ece8d8', dim: '#a9a692', card: 'rgba(24,27,26,0.93)',
  approve: '#4ea85a', deny: '#d0493f', error: '#8b909a', gold: '#f5c542',
};
const FONT = (size, weight = 'bold') => `${weight} ${size}px Consolas, "Lucida Console", "Courier New", monospace`;

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function fillRR(ctx, x, y, w, h, r, fill, stroke, lineWidth = 2) {
  roundRectPath(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function circle(ctx, x, y, r, fill, stroke, lineWidth = 2) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function text(ctx, value, x, y, { size = 13, weight = 'bold', color = C.text, align = 'left', baseline = 'alphabetic', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = FONT(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(value, x, y);
  ctx.restore();
}

function fitText(ctx, value, maxWidth, size, weight = 'bold') {
  ctx.save();
  ctx.font = FONT(size, weight);
  let out = String(value);
  if (ctx.measureText(out).width > maxWidth) {
    while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) out = out.slice(0, -1);
    out = `${out}...`;
  }
  ctx.restore();
  return out;
}

function wrapLines(ctx, value, maxWidth, size, maxLines) {
  ctx.save();
  ctx.font = FONT(size, 'normal');
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  ctx.restore();
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\.*$/, '')}...`;
  }
  return lines;
}

const shade = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const adjust = (v) => clamp(Math.round(v + amount * 255), 0, 255);
  return `rgb(${adjust(n >> 16)}, ${adjust((n >> 8) & 255)}, ${adjust(n & 255)})`;
};

// ---------------------------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------------------------

function drawApplicant(ctx, x, y, look, { alpha = 1, bob = 0, tilt = 0, tint = null } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y + bob);
  ctx.rotate(tilt);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(2, 6, 16, 9, 0, 0, TAU);
  ctx.fill();
  fillRR(ctx, -15, -6, 30, 17, 8, tint ?? look.coat, 'rgba(0,0,0,0.45)', 1.5);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(-1, -5, 2, 15);
  circle(ctx, -9.5, -2, 2.6, look.skin);
  circle(ctx, 9.5, -2, 2.6, look.skin);
  circle(ctx, 0, -3, 8.6, look.hair, 'rgba(0,0,0,0.45)', 1.5);
  if (look.hat) {
    ctx.fillStyle = shade(look.coat, -0.18);
    ctx.beginPath();
    ctx.ellipse(0, -3, 12, 9.5, 0, 0, TAU);
    ctx.fill();
    circle(ctx, 0, -3, 5.4, shade(look.coat, -0.05), 'rgba(0,0,0,0.35)', 1);
  }
  ctx.restore();
}

function drawApprover(ctx, x, y, { accent, skin, hair, pose, t, bob }) {
  ctx.save();
  ctx.translate(x, y + bob);
  circle(ctx, 0, 4, 27, '#25282b', '#15171a', 2);
  fillRR(ctx, -27, -6, 54, 27, 12, accent, 'rgba(0,0,0,0.5)', 2);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(-1.5, -5, 3, 25);
  fillRR(ctx, -9, -8, 18, 6, 3, '#f2efe3');

  const reading = pose.mode === 'reviewing';
  const lean = reading ? Math.sin(t * 9) * 1.2 : 0;
  const armUp = pose.mode === 'cheer';
  const stampDrop = pose.mode === 'stamping' ? pose.stamp : 0;

  ctx.lineCap = 'round';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 9;
  const leftHand = armUp ? [-34, -30 + Math.sin(t * 12) * 4] : [-14, 36];
  const rightHand = armUp ? [34, -30 + Math.cos(t * 12) * 4] : [16 + stampDrop * 6, 34 + stampDrop * 6];
  for (const [shoulderX, hand] of [[-23, leftHand], [23, rightHand]]) {
    ctx.beginPath();
    ctx.moveTo(shoulderX, 6);
    ctx.lineTo(hand[0], hand[1]);
    ctx.stroke();
    circle(ctx, hand[0], hand[1], 5, skin, 'rgba(0,0,0,0.4)', 1);
  }

  circle(ctx, lean, 3, 13, hair, 'rgba(0,0,0,0.5)', 1.5);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(lean, 9, 8.5, 5.6, 0, 0, TAU);
  ctx.fill();
  const eyeY = reading ? 10.5 : 9;
  circle(ctx, lean - 3.2, eyeY, 1.1, '#1b1b1b');
  circle(ctx, lean + 3.2, eyeY, 1.1, '#1b1b1b');
  ctx.restore();
}

function drawPaper(ctx, x, y, { w = 42, h = 30, rot = 0, mark = null, markAlpha = 1, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w, h);
  ctx.fillStyle = C.paper;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = C.ink;
  ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w * 0.45, 2.4);
  for (let i = 0; i < 3; i++) ctx.fillRect(-w / 2 + 5, -h / 2 + 11 + i * 5, w - 10 - (i === 2 ? 14 : 0), 1.6);
  if (mark) {
    const color = mark === 'approve' ? C.approve : mark === 'reject' ? C.deny : C.error;
    const label = mark === 'approve' ? 'OK' : mark === 'reject' ? 'NO' : '!';
    ctx.save();
    ctx.globalAlpha *= markAlpha;
    ctx.rotate(-0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(-12, -8, 24, 16);
    text(ctx, label, 0, 5, { size: 13, color, align: 'center' });
    ctx.restore();
  }
  ctx.restore();
}

function drawStampTool(ctx, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-9, 2, 22, 16);
  fillRR(ctx, -10, -2, 20, 14, 4, shade(color, -0.12), 'rgba(0,0,0,0.5)', 1.5);
  circle(ctx, 0, -8, 7, '#3a2d22', 'rgba(0,0,0,0.5)', 1.5);
  circle(ctx, 0, -8, 3.2, shade('#3a2d22', 0.18));
  ctx.restore();
}

function drawTray(ctx, x, y, color, label, count) {
  fillRR(ctx, x, y, 72, 36, 5, shade(color, -0.32), shade(color, -0.12), 2);
  const stack = Math.min(5, count);
  for (let i = 0; i < stack; i++) {
    ctx.fillStyle = i % 2 ? '#e2dcc7' : C.paper;
    ctx.fillRect(x + 6 + i * 1.5, y + 18 - i * 1.5, 34, 14);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x + 6 + i * 1.5, y + 18 - i * 1.5, 34, 14);
  }
  text(ctx, label, x + 6, y + 11, { size: 9, color: shade(color, 0.28) });
  text(ctx, String(count), x + 66, y + 30, { size: 16, color: '#ffffff', align: 'right' });
}

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

export class Renderer {
  /** @param {HTMLCanvasElement} canvas @param {() => object} getState returns { race, config, settings, selectedDesk } */
  constructor(canvas, getState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.scale = 1;
    this.bg = document.createElement('canvas');
    this.lanes = [0, 1, 2].map(() => this.freshLane());
    this.particles = [];
    this.floaters = [];
    this.lastFrame = performance.now();
    this.running = false;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(320, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.round((width * WORLD.h) / WORLD.w);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.scale = width / WORLD.w;
    this.bg.width = width;
    this.bg.height = height;
    this.paintBackground();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      try {
        this.frame(now);
      } catch (error) {
        if (!this.reportedError) console.error('Render error (the loop keeps running):', error);
        this.reportedError = true;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** Maps a mouse event to a lane index, or -1. */
  laneAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WORLD.w;
    const lane = Math.floor((x - LANE_X0) / LANE_W);
    return lane >= 0 && lane < 3 ? lane : -1;
  }

  // ---- events from the race ------------------------------------------------------------------

  handleEvent(type, data) {
    const now = performance.now();
    if (type === 'status') {
      const { race } = this.getState();
      if (race?.status === 'ready') this.resetVisuals();
      return;
    }
    const index = data.run ? data.run.meta.id - 1 : -1;
    const lane = this.lanes[index];
    if (!lane) return;
    const cx = laneCx(index);

    if (type === 'decision') {
      lane.mark = { paperId: data.paper.id, decision: data.record.ok ? data.record.decision : 'error', start: now, splashed: false };
      // One floater per lane: fast desks decide several times a second and would otherwise stack up.
      this.floaters = this.floaters.filter((f) => f.lane !== index);
      this.floaters.push({
        lane: index,
        x: cx - 38,
        y: Y.approver + 8,
        start: now,
        label: data.record.ok ? fmtMs(data.record.latencyMs) : 'ERROR',
        color: data.record.ok ? C.text : C.error,
        wrong: data.record.ok && !data.record.correct,
      });
    } else if (type === 'exit') {
      const decision = data.record.ok ? data.record.decision : 'error';
      lane.flying.push({ start: now, decision, toX: decision === 'approve' ? laneX(index) + LANE_W - 82 : laneX(index) + 82 });
      lane.mark = null;
    } else if (type === 'desk-finished') {
      lane.finishedAt = now;
      lane.rank = data.rank;
      this.confetti(index, data.rank === 1 ? 120 : 36);
    }
  }

  freshLane() {
    return { actors: new Map(), mark: null, flying: [], finishedAt: null, rank: null, paperId: null, paperStart: 0 };
  }

  resetVisuals() {
    this.lanes = [0, 1, 2].map(() => this.freshLane());
    this.particles.length = 0;
    this.floaters.length = 0;
  }

  confetti(index, count) {
    const now = performance.now();
    const cx = laneCx(index);
    const colors = [ACCENTS[index], C.gold, '#ffffff', C.approve, '#e86f9a'];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 120, y: Y.card - 40, vx: (Math.random() - 0.5) * 360, vy: -200 - Math.random() * 420,
        g: 620, size: 3 + Math.random() * 4, color: colors[i % colors.length], start: now, life: 1400 + Math.random() * 800, spin: Math.random() * 6,
      });
    }
  }

  splash(index, color) {
    const now = performance.now();
    const x = laneCx(index);
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * TAU;
      const speed = 60 + Math.random() * 160;
      this.particles.push({ x, y: Y.mat + 18, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 30, g: 300, size: 2 + Math.random() * 2.5, color, start: now, life: 420, spin: 0 });
    }
  }

  // ---- frame ---------------------------------------------------------------------------------

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const state = this.getState();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    this.drawWall(ctx, state, now);
    state.race.runs.forEach((run, i) => {
      this.syncActors(i, run, state, now, dt);
      this.drawLane(ctx, i, run, state, now);
    });
    this.drawParticles(ctx, now, dt);
    this.drawFloaters(ctx, now);
  }

  // ---- static background ---------------------------------------------------------------------

  paintBackground() {
    const ctx = this.bg.getContext('2d');
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = C.wall;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);

    ctx.fillStyle = C.floorA;
    ctx.fillRect(0, 112, WORLD.w, WORLD.h - 112);
    for (let gx = 0; gx < WORLD.w; gx += 64) {
      for (let gy = 112; gy < WORLD.h; gy += 64) {
        if (((gx / 64) + ((gy - 112) / 64)) % 2 === 0) {
          ctx.fillStyle = C.floorB;
          ctx.fillRect(gx, gy, 64, 64);
        }
      }
    }
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= WORLD.w; gx += 64) {
      ctx.moveTo(gx, 112);
      ctx.lineTo(gx, WORLD.h);
    }
    for (let gy = 112; gy <= WORLD.h; gy += 64) {
      ctx.moveTo(0, gy);
      ctx.lineTo(WORLD.w, gy);
    }
    ctx.stroke();

    ctx.fillStyle = C.wallDark;
    ctx.fillRect(0, 104, WORLD.w, 8);
    for (let x = 0; x < WORLD.w; x += 80) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, 0, 2, 104);
    }

    for (let i = 0; i < 3; i++) this.paintLaneStatic(ctx, i);

    const vignette = ctx.createRadialGradient(WORLD.w / 2, WORLD.h / 2, WORLD.h * 0.4, WORLD.w / 2, WORLD.h / 2, WORLD.w * 0.62);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  }

  paintLaneStatic(ctx, i) {
    const x0 = laneX(i);
    const cx = laneCx(i);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x0 + 10, 112, 2, WORLD.h - 112);
    ctx.fillRect(x0 + LANE_W - 12, 112, 2, WORLD.h - 112);

    const top = Y.window + 14;
    const bottom = Y.slot0 + MAX_SLOTS * Y.slotGap - 8;
    ctx.fillStyle = C.carpetDark;
    ctx.fillRect(cx - 38, top, 76, bottom - top);
    ctx.fillStyle = C.carpet;
    ctx.fillRect(cx - 34, top, 68, bottom - top);
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 2;
    for (let y = bottom - 16; y > top; y -= 36) {
      ctx.beginPath();
      ctx.moveTo(cx - 14, y);
      ctx.lineTo(cx, y - 10);
      ctx.lineTo(cx + 14, y);
      ctx.stroke();
    }
    for (const side of [-1, 1]) {
      const px = cx + side * 48;
      ctx.strokeStyle = '#b8a14a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, top + 6);
      for (let y = top + 6; y < bottom - 4; y += 70) {
        const next = Math.min(y + 70, bottom - 4);
        ctx.quadraticCurveTo(px + side * 3, (y + next) / 2 + 12, px, next);
      }
      ctx.stroke();
      for (let y = top + 6; y <= bottom - 4; y += 70) {
        circle(ctx, px, y, 5, '#2b2e30', '#b8a14a', 2);
      }
    }
    fillRR(ctx, cx - 46, bottom + 6, 92, 22, 4, '#2b2e30', '#554f3b', 1.5);
    text(ctx, 'ENTRANCE', cx, bottom + 22, { size: 11, color: C.dim, align: 'center' });

    const deskX = x0 + 28;
    const deskW = LANE_W - 56;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(deskX + 4, Y.desk + Y.deskH, deskW, 10);
    fillRR(ctx, deskX, Y.desk, deskW, Y.deskH, 6, C.wood, C.woodDark, 3);
    ctx.fillStyle = C.woodDark;
    ctx.fillRect(deskX + 3, Y.desk + Y.deskH - 9, deskW - 6, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let k = 0; k < 6; k++) ctx.fillRect(deskX + 10, Y.desk + 6 + k * 6, deskW - 20, 1);
    fillRR(ctx, cx - 38, Y.mat - 2, 76, 40, 4, '#3d4a3c', '#27302a', 2);
    fillRR(ctx, cx + 46, Y.mat + 6, 26, 22, 4, '#2a2330', '#16121a', 1.5);
    circle(ctx, cx + 59, Y.mat + 17, 7, '#4b3a66');
  }

  // ---- wall ----------------------------------------------------------------------------------

  drawWall(ctx, { race, config, settings }, now) {
    text(ctx, 'CHECKPOINT ONE', 40, 52, { size: 32, color: C.text });
    text(ctx, 'MINISTRY OF ENTRY  -  NOVARIA  -  AI MODEL SPEED RACE', 42, 76, { size: 12, color: C.dim });

    fillRR(ctx, 500, 14, 280, 78, 8, '#0d1210', '#3a423c', 3);
    const running = race.status === 'running' || race.status === 'finished';
    const caption = { ready: 'PRESS START SHIFT', warming: 'BRIEFING THE APPROVERS...', running: 'SHIFT CLOCK', finished: 'SHIFT COMPLETE' }[race.status];
    const attention = race.status === 'ready' || race.status === 'warming';
    text(ctx, caption, 640, 32, { size: 12, color: attention ? '#ffd97a' : '#5f8a6c', align: 'center', alpha: attention ? 0.6 + 0.4 * Math.sin(now / 260) : 1 });
    text(ctx, fmtClock(running ? race.elapsed(now) : 0), 640, 76, { size: 46, color: running ? '#7cff9b' : '#3f6b4c', align: 'center' });

    const simulated = config.mock;
    fillRR(ctx, 864, 18, simulated ? 156 : 124, 24, 12, simulated ? '#7a4a00' : '#12391f', simulated ? '#ffb020' : '#4ea85a', 2);
    text(ctx, simulated ? 'SIMULATED MODELS' : 'LIVE MODELS', simulated ? 942 : 926, 35, { size: 12, color: simulated ? '#ffcf70' : '#8ef0a0', align: 'center' });
    text(ctx, `${race.papers.length} applicants per desk  -  seed ${settings.seed}`, 864, 62, { size: 13, color: C.text });
    const overhead = race.pace.stepMs + race.pace.stampMs;
    text(ctx, `Animation overhead: ${overhead} ms per applicant, same for every desk`, 864, 82, { size: 11, color: C.dim, weight: 'normal' });
  }

  // ---- actors --------------------------------------------------------------------------------

  slotPosition(index, queueIndex) {
    const cx = laneCx(index);
    if (queueIndex === 0) return { x: cx, y: Y.window, visible: true };
    const slot = queueIndex - 1;
    return { x: cx, y: Y.slot0 + slot * Y.slotGap, visible: slot < MAX_SLOTS };
  }

  syncActors(index, run, { race }, now, dt) {
    const lane = this.lanes[index];
    const cx = laneCx(index);
    const rate = race.pace.stepMs === 0 ? 60 : clamp(1800 / Math.max(race.pace.stepMs, 90), 5, 24);
    const k = 1 - Math.exp(-dt * rate);

    const live = new Set();
    run.queue.forEach((paper, queueIndex) => {
      live.add(paper.id);
      const target = this.slotPosition(index, queueIndex);
      let actor = lane.actors.get(paper.id);
      if (!actor) {
        const startY = target.visible ? target.y : Y.slot0 + MAX_SLOTS * Y.slotGap;
        actor = { paper, x: target.x, y: startY, alpha: target.visible ? 1 : 0, leave: null };
        lane.actors.set(paper.id, actor);
      }
      actor.moving = Math.abs(target.y - actor.y) > 1.2;
      actor.x += (target.x - actor.x) * k;
      actor.y += (target.y - actor.y) * k;
      actor.alpha += ((target.visible ? 1 : 0) - actor.alpha) * k;
    });

    for (const entry of run.leaving) {
      live.add(entry.paper.id);
      const actor = lane.actors.get(entry.paper.id);
      if (!actor) continue;
      if (!actor.leave) {
        const decision = entry.record.ok ? entry.record.decision : 'error';
        actor.leave = { start: entry.at, dir: decision === 'approve' ? 1 : -1, decision };
      }
      const elapsed = now - actor.leave.start;
      actor.x += (cx + actor.leave.dir * 196 - actor.x) * (1 - Math.exp(-dt * 7));
      actor.y += (Y.window - 2 - actor.y) * k;
      actor.alpha = 1 - clamp((elapsed - 120) / 520, 0, 1);
      actor.moving = true;
    }

    for (const [id, actor] of lane.actors) {
      const gone = actor.leave && actor.alpha <= 0.01;
      if (!live.has(id) || gone) lane.actors.delete(id);
    }
    lane.flying = lane.flying.filter((fly) => now - fly.start < 420);
  }

  // ---- lane ----------------------------------------------------------------------------------

  drawLane(ctx, index, run, { selectedDesk, race }, now) {
    const lane = this.lanes[index];
    const accent = ACCENTS[index];
    const cx = laneCx(index);
    const x0 = laneX(index);
    const stats = run.stats(now);
    const offline = run.phase === 'offline' || run.phase === 'aborted';
    const stampMs = clamp(race.pace.stampMs, 60, 260);

    if (selectedDesk === index) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(x0 + 6, 118, LANE_W - 12, WORLD.h - 128);
      ctx.restore();
    }

    this.drawNameplate(ctx, index, run, accent, now);

    // Trays and desk props
    drawTray(ctx, x0 + 46, Y.mat - 4, C.deny, 'DENIED', stats.denied);
    drawTray(ctx, x0 + LANE_W - 46 - 72, Y.mat - 4, C.approve, 'APPROVED', stats.approved);

    // Paper on the mat while an applicant is being processed
    const atWindow = run.queue[0];
    const processing = atWindow && (run.phase === 'reviewing' || run.phase === 'stamping');
    const mark = lane.mark && atWindow && lane.mark.paperId === atWindow.id ? lane.mark : null;
    if (processing) {
      if (lane.paperId !== atWindow.id) {
        lane.paperId = atWindow.id;
        lane.paperStart = now;
      }
      const slide = easeOutCubic((now - lane.paperStart) / 140);
      const impactAt = mark ? clamp((now - mark.start) / stampMs, 0, 1) : 0;
      const stamped = mark && impactAt >= 0.45;
      if (mark && stamped && !mark.splashed) {
        mark.splashed = true;
        this.splash(index, mark.decision === 'approve' ? C.approve : mark.decision === 'reject' ? C.deny : C.error);
      }
      drawPaper(ctx, cx, Y.mat + 17 + (1 - slide) * 34, { rot: -0.04, mark: stamped ? mark.decision : null, markAlpha: stamped ? clamp((impactAt - 0.45) * 8, 0, 1) : 0 });
      if (mark) {
        const lift = impactAt < 0.45 ? 1 - easeInOut(impactAt / 0.45) : easeInOut((impactAt - 0.45) / 0.55);
        const color = mark.decision === 'approve' ? C.approve : mark.decision === 'reject' ? C.deny : C.error;
        drawStampTool(ctx, cx + 4, Y.mat + 14 - lift * 24, color);
      }
    }
    for (const fly of lane.flying) {
      const t = easeOutCubic((now - fly.start) / 360);
      const color = fly.decision;
      drawPaper(ctx, cx + (fly.toX - cx) * t, Y.mat + 17 - Math.sin(t * Math.PI) * 14, { w: 34, h: 24, rot: -0.04 + t * 0.3, mark: color, alpha: 1 - t * 0.35 });
    }

    // Applicants (back to front: far queue first)
    const actors = [...lane.actors.values()].sort((a, b) => b.y - a.y);
    for (const actor of actors) {
      const tint = actor.leave?.decision === 'error' ? '#777c85' : null;
      const bob = actor.moving ? Math.sin(now / 55 + actor.paper.id * 1.7) * 1.6 : 0;
      drawApplicant(ctx, actor.x, actor.y, actor.paper.appearance, { alpha: clamp(actor.alpha, 0, 1), bob, tilt: actor.moving ? Math.sin(now / 80 + actor.paper.id) * 0.06 : 0, tint });
    }
    if (atWindow && lane.actors.get(atWindow.id) && run.phase !== 'finished') {
      text(ctx, `#${atWindow.id}`, cx + 24, Y.window + 4, { size: 12, color: C.dim });
    }

    const hidden = Math.max(0, run.queue.length - 1 - MAX_SLOTS);
    if (hidden > 0) {
      const entranceY = Y.slot0 + MAX_SLOTS * Y.slotGap - 2;
      fillRR(ctx, cx - 50, entranceY, 100, 22, 11, '#15171a', accent, 1.5);
      text(ctx, `+${hidden} waiting`, cx, entranceY + 15, { size: 12, color: C.text, align: 'center' });
    }

    // Approver
    const pose = this.poseFor(run, lane, now, stampMs);
    const bob = run.phase === 'reviewing' ? Math.sin(now / 140) * 0.8 : Math.sin(now / 700 + index) * 0.6;
    drawApprover(ctx, cx, Y.approver, { accent: offline ? '#5d6168' : accent, skin: ['#e0a97c', '#c68642', '#f1c9a5'][index], hair: ['#2b1d0e', '#1b1b1b', '#7a5230'][index], pose, t: now / 1000, bob });
    this.drawThought(ctx, index, run, accent, now);

    if (lane.finishedAt) this.drawFinish(ctx, index, run, accent, now);
    if (offline) this.drawOffline(ctx, index, run);
    this.drawCard(ctx, index, stats, accent);
  }

  poseFor(run, lane, now, stampMs) {
    if (run.phase === 'finished') return { mode: 'cheer' };
    if (run.phase === 'stamping' && lane.mark) return { mode: 'stamping', stamp: easeInOut(clamp((now - lane.mark.start) / stampMs, 0, 1)) };
    if (run.phase === 'reviewing') return { mode: 'reviewing' };
    return { mode: 'idle' };
  }

  drawNameplate(ctx, index, run, accent, now) {
    const desk = run.meta;
    const x = laneCx(index) - 160;
    const offline = run.phase === 'offline' || run.phase === 'aborted';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 4, Y.sign + 4, 320, 54);
    fillRR(ctx, x, Y.sign, 320, 54, 6, '#1d2120', accent, 3);
    ctx.fillStyle = accent;
    ctx.fillRect(x + 3, Y.sign + 3, 8, 48);
    text(ctx, fitText(ctx, desk.label, 190, 20), x + 22, Y.sign + 25, { size: 20, color: C.text });
    text(ctx, fitText(ctx, `${desk.providerLabel} - ${desk.model || 'no model'}`, 232, 12, 'normal'), x + 22, Y.sign + 44, { size: 12, weight: 'normal', color: C.dim });

    const chip = desk.kind === 'systemone' ? 'SYSTEM ONE' : 'LLM';
    const chipW = desk.kind === 'systemone' ? 82 : 44;
    fillRR(ctx, x + 320 - chipW - 30, Y.sign + 9, chipW, 18, 9, shade(accent, -0.4), accent, 1.5);
    text(ctx, chip, x + 320 - 30 - chipW / 2, Y.sign + 22, { size: 10, color: '#ffffff', align: 'center' });

    const led = offline ? C.deny : run.phase === 'reviewing' ? '#7cff9b' : run.phase === 'finished' ? C.gold : run.terminal ? C.error : '#a9a692';
    const pulse = run.phase === 'reviewing' ? 0.6 + 0.4 * Math.sin(now / 90) : 1;
    ctx.save();
    ctx.globalAlpha = pulse;
    circle(ctx, x + 320 - 16, Y.sign + 18, 6, led, 'rgba(0,0,0,0.6)', 1.5);
    ctx.restore();
  }

  drawThought(ctx, index, run, accent, now) {
    if (run.phase !== 'reviewing') return;
    const cx = laneCx(index);
    const elapsed = now - run.phaseStart;
    const label = fmtMs(elapsed);
    const dots = '.'.repeat(1 + (Math.floor(now / 220) % 3));
    const w = 104;
    fillRR(ctx, cx + 34, Y.approver - 36, w, 24, 12, 'rgba(240,236,220,0.96)', 'rgba(0,0,0,0.55)', 1.5);
    circle(ctx, cx + 30, Y.approver - 12, 3, 'rgba(240,236,220,0.96)');
    text(ctx, `${label}${dots.padEnd(3, ' ')}`, cx + 34 + w / 2, Y.approver - 19, { size: 13, color: '#222', align: 'center' });
    if (elapsed > 3000) {
      ctx.save();
      ctx.fillStyle = '#7ec8ff';
      ctx.beginPath();
      ctx.moveTo(cx + 18, Y.approver - 22);
      ctx.quadraticCurveTo(cx + 24, Y.approver - 12, cx + 18, Y.approver - 8);
      ctx.quadraticCurveTo(cx + 12, Y.approver - 12, cx + 18, Y.approver - 22);
      ctx.fill();
      ctx.restore();
    }
  }

  drawFinish(ctx, index, run, accent, now) {
    const lane = this.lanes[index];
    const cx = laneCx(index);
    const t = easeOutCubic((now - lane.finishedAt) / 400);
    const stats = run.stats(now);
    const medal = [C.gold, '#cfd6dd', '#c98a4b'][clamp(lane.rank - 1, 0, 2)];
    ctx.save();
    ctx.globalAlpha = t;
    fillRR(ctx, cx - 150, 392, 300, 92, 12, 'rgba(12,14,13,0.9)', accent, 3);
    circle(ctx, cx - 100, 438, 26, medal, 'rgba(0,0,0,0.5)', 2);
    text(ctx, String(lane.rank), cx - 100, 447, { size: 28, color: '#241c05', align: 'center' });
    text(ctx, 'QUEUE CLEARED', cx - 62, 424, { size: 18, color: C.text });
    text(ctx, fmtMs(stats.elapsedMs), cx - 62, 452, { size: 26, color: accent });
    text(ctx, `${fmtMs(stats.avgMs)} avg decision`, cx - 62, 474, { size: 12, color: C.dim, weight: 'normal' });
    ctx.restore();
  }

  drawOffline(ctx, index, run) {
    const cx = laneCx(index);
    const x0 = laneX(index);
    ctx.fillStyle = 'rgba(10,10,12,0.62)';
    ctx.fillRect(x0 + 14, 160, LANE_W - 28, 440);
    const title = run.phase === 'aborted' ? 'DESK STOPPED' : 'DESK OFFLINE';
    text(ctx, title, cx, 330, { size: 24, color: C.deny, align: 'center' });
    const lines = wrapLines(ctx, run.note || 'Not configured', LANE_W - 70, 13, 5);
    lines.forEach((line, i) => text(ctx, line, cx, 360 + i * 18, { size: 13, weight: 'normal', color: C.text, align: 'center' }));
  }

  drawCard(ctx, index, stats, accent) {
    const x = laneX(index) + 20;
    const w = LANE_W - 40;
    fillRR(ctx, x, Y.card, w, 90, 8, C.card, accent, 2.5);

    const barX = x + 12;
    const barW = w - 90;
    fillRR(ctx, barX, Y.card + 12, barW, 12, 6, '#0b0d0c', '#3a403c', 1);
    const progress = stats.total ? stats.done / stats.total : 0;
    if (progress > 0) fillRR(ctx, barX, Y.card + 12, Math.max(12, barW * progress), 12, 6, accent);
    text(ctx, `${stats.done}/${stats.total}`, x + w - 12, Y.card + 23, { size: 14, color: C.text, align: 'right' });

    // `Wrong` = answers that did not match the ground truth; `Failed` = calls that produced no usable answer.
    const rows = [
      [{ t: `Last ${fmtMs(stats.lastMs)}` }, { t: `Avg ${fmtMs(stats.avgMs)}` }, { t: `P95 ${fmtMs(stats.p95Ms)}` }],
      [{ t: `Acc ${fmtPercent(stats.accuracy)}` }, { t: `Wrong ${stats.wrong}`, c: stats.wrong > 0 ? C.deny : null }, { t: stats.perMinute ? `${stats.perMinute.toFixed(stats.perMinute < 100 ? 1 : 0)}/min` : '-/min' }],
      [{ t: `Tok ${fmtTokenTotal(stats)}` }, { t: `Cost ${fmtMoney(stats.cost)}` }, { t: `Failed ${stats.errors}`, c: stats.errors > 0 ? C.deny : null }],
    ];
    rows.forEach((cols, r) => {
      const y = Y.card + 45 + r * 16;
      const base = r === 0 ? C.text : C.dim;
      text(ctx, cols[0].t, x + 12, y, { size: 13, color: cols[0].c ?? base });
      text(ctx, cols[1].t, x + 132, y, { size: 13, color: cols[1].c ?? base });
      text(ctx, cols[2].t, x + w - 12, y, { size: 13, color: cols[2].c ?? base, align: 'right' });
    });
  }

  // ---- particles & overlays --------------------------------------------------------------------

  drawParticles(ctx, now, dt) {
    this.particles = this.particles.filter((p) => now - p.start < p.life);
    for (const p of this.particles) {
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const age = (now - p.start) / p.life;
      ctx.save();
      ctx.globalAlpha = 1 - age * age;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin + age * 8);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    }
  }

  drawFloaters(ctx, now) {
    this.floaters = this.floaters.filter((f) => now - f.start < 900);
    for (const f of this.floaters) {
      const age = (now - f.start) / 900;
      const alpha = 1 - clamp((age - 0.45) / 0.55, 0, 1);
      const y = f.y - age * 26;
      text(ctx, f.label, f.x, y, { size: 16, color: f.color, align: 'right', alpha });
      if (f.wrong) text(ctx, 'WRONG', f.x, y + 16, { size: 12, color: C.deny, align: 'right', alpha });
    }
  }
}
