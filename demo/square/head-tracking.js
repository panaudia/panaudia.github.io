// Head-tracking opt-in panel for the town square, ported from the old
// panaudia.com singers page. Owns the panel, capability gating and the
// voltface tracker lifecycle, and exposes a shared `headTracking` state
// object that world.js reads in move() to compose the face rotation
// into the outgoing pose.
//
// voltface runs MediaPipe's face landmarker on a webcam frame and
// reports the head rotation relative to a calibrated neutral. The
// MediaPipe runtime and model come from jsDelivr and Google's model
// store, lazily on first enable; both send CORS headers, so they load
// under the page's cross-origin isolation.

// Shared singleton state. ES module instances are shared across importers, so
// world.js sees this exact object.
export const headTracking = {
  /** True while the tracker is running and the user has opted in. */
  enabled: false,
  /** Latest voltface HeadPose, or null when disabled / no face seen yet. */
  latestPose: null,
  /** `performance.now()` of the last pose. world.js uses this to detect a lost
   *  face (poses stop arriving) and decay the head delta back to neutral. */
  lastPoseAt: 0,
  /** Recalibrate neutral. No-op until enabled; rebound by enable(). */
  recenter: () => {},
};

let injected = false;

function isTouchDevice() {
  return Boolean(
    navigator.maxTouchPoints || "ontouchstart" in document.documentElement,
  );
}

async function hasCamera() {
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // `kind` is visible without permission (only the label is gated).
    return devices.some((d) => d.kind === "videoinput");
  } catch {
    return false;
  }
}

// ---- "From behind" head wireframe (ported from the voltface demo) -----------
// A simple 2D line drawing of a head, rotated by yaw/pitch/roll, drawn in the
// site accent to match the audio controls. +180° yaw at rest so the BACK of the head faces
// the viewer (a glanceable "where am I looking" indicator).

const HEAD_W = 92;
const HEAD_H = 108;

const HEAD_MODEL = (() => {
  const verts = [];
  const edges = [];
  const W = 0.42; // half-width  (left-right)
  const H = 0.55; // half-height (up-down)
  const D = 0.5; // half-depth  (front-back; +z is face direction)

  const NLAT = 5;
  const NLON = 12;
  const ringStart = [];
  for (let li = 0; li < NLAT; li++) {
    const phi = ((li + 1) / (NLAT + 1)) * Math.PI;
    const y = H * Math.cos(phi);
    const r = Math.sin(phi);
    ringStart.push(verts.length);
    for (let i = 0; i < NLON; i++) {
      const theta = (i / NLON) * 2 * Math.PI;
      verts.push([W * r * Math.sin(theta), y, D * r * Math.cos(theta)]);
    }
  }
  for (let li = 0; li < NLAT; li++) {
    for (let i = 0; i < NLON; i++) {
      edges.push([ringStart[li] + i, ringStart[li] + ((i + 1) % NLON)]);
    }
  }
  const top = verts.length;
  verts.push([0, H, 0]);
  const bot = verts.length;
  verts.push([0, -H, 0]);
  for (let i = 0; i < NLON; i += 2) {
    edges.push([top, ringStart[0] + i]);
    for (let li = 0; li < NLAT - 1; li++) {
      edges.push([ringStart[li] + i, ringStart[li + 1] + i]);
    }
    edges.push([ringStart[NLAT - 1] + i, bot]);
  }

  // Nose
  const nTip = verts.length; verts.push([0, -0.05, D + 0.1]);
  const nTop = verts.length; verts.push([0, 0.1, D * 0.95]);
  const nL = verts.length; verts.push([-0.06, -0.13, D * 0.85]);
  const nR = verts.length; verts.push([0.06, -0.13, D * 0.85]);
  edges.push([nTop, nTip], [nTip, nL], [nTip, nR], [nL, nR]);

  // Eyes
  const eLO = verts.length; verts.push([-0.18, 0.05, D * 0.88]);
  const eLI = verts.length; verts.push([-0.07, 0.05, D * 0.95]);
  const eRI = verts.length; verts.push([0.07, 0.05, D * 0.95]);
  const eRO = verts.length; verts.push([0.18, 0.05, D * 0.88]);
  edges.push([eLO, eLI], [eRI, eRO]);

  // Mouth
  const mL = verts.length; verts.push([-0.1, -0.27, D * 0.92]);
  const mR = verts.length; verts.push([0.1, -0.27, D * 0.92]);
  edges.push([mL, mR]);

  // Ears
  const elT = verts.length; verts.push([-W - 0.01, 0.1, 0]);
  const elB = verts.length; verts.push([-W - 0.01, -0.1, 0]);
  const elO = verts.length; verts.push([-W - 0.07, 0, 0]);
  edges.push([elT, elO], [elO, elB], [elT, elB]);
  const erT = verts.length; verts.push([W + 0.01, 0.1, 0]);
  const erB = verts.length; verts.push([W + 0.01, -0.1, 0]);
  const erO = verts.length; verts.push([W + 0.07, 0, 0]);
  edges.push([erT, erO], [erO, erB], [erT, erB]);

  return { verts, edges };
})();

function renderHead(ctx, yaw, pitch, roll, intensity) {
  const yawA = yaw + Math.PI; // back of the head faces the viewer at rest
  const cy = Math.cos(yawA), sy = Math.sin(yawA);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);

  const SCALE = Math.min(HEAD_W, HEAD_H) * 0.50;
  const CX = HEAD_W / 2, CY = HEAD_H / 2;

  const projected = HEAD_MODEL.verts.map(([x, y, z]) => {
    const x1 = cz * x - sz * y;
    const y1 = sz * x + cz * y;
    const y2 = cx * y1 - sx * z;
    const z2 = sx * y1 + cx * z;
    const x3 = cy * x1 + sy * z2;
    const z3 = -sy * x1 + cy * z2;
    return { x: x3 * SCALE + CX, y: -y2 * SCALE + CY, z: z3 };
  });

  ctx.clearRect(0, 0, HEAD_W, HEAD_H);
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  for (const [a, b] of HEAD_MODEL.edges) {
    const va = projected[a], vb = projected[b];
    const t = ((va.z + vb.z) / 2 + 0.6) / 1.2;
    const alpha = (0.2 + 0.8 * Math.max(0, Math.min(1, t))) * intensity;
    ctx.strokeStyle = `rgba(111, 201, 216, ${alpha})`; // the site accent, #6fc9d8
    ctx.beginPath();
    ctx.moveTo(va.x, va.y);
    ctx.lineTo(vb.x, vb.y);
    ctx.stroke();
  }
}

/**
 * Build and wire the panel, if the device qualifies. Called from start.js with
 * the self-hosted asset URLs. Leaves the panel ABSENT on touch devices or when
 * no camera is present.
 */
export async function initHeadTrackingUI({ wasmBasePath, modelAssetPath }) {
  if (injected) return;
  if (isTouchDevice()) return; // desktop only for now
  if (!(await hasCamera())) return; // no camera => no panel at all

  const holder = document.getElementById("audio-controls");
  if (!holder) return;

  injected = true;

  const panel = document.createElement("div");
  panel.id = "head-tracking-panel";
  panel.className = "ht-panel";
  panel.innerHTML = `
    <div id="ht-error" class="ht-error" hidden></div>
    <a id="ht-enable" class="ht-link" role="button" tabindex="0">Head tracking</a>
    <div id="ht-expanded" class="ht-expanded">
      <video id="ht-preview" class="ht-video-hidden" autoplay playsinline muted></video>
      <canvas id="ht-head" class="ht-head"></canvas>
      <div class="ht-btn-row">
        <a id="ht-recenter" class="ht-link" role="button" tabindex="0">Recenter (C)</a>
        <a id="ht-disable" class="ht-link" role="button" tabindex="0">Off</a>
      </div>
    </div>`;
  // Between the identity row and the volume/mute rows.
  holder.insertBefore(panel, holder.querySelector(".volume-row"));

  const el = (id) => document.getElementById(id);
  const enableBtn = el("ht-enable");
  const errorBox = el("ht-error");
  const preview = el("ht-preview");

  const headCanvas = el("ht-head");
  const headCtx = headCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  headCanvas.style.width = `${HEAD_W}px`;
  headCanvas.style.height = `${HEAD_H}px`;
  headCanvas.width = HEAD_W * dpr;
  headCanvas.height = HEAD_H * dpr;
  headCtx.scale(dpr, dpr);

  let tracker = null;
  let stream = null;
  let unsub = null;
  let rafId = null;
  let starting = false;

  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  };
  const clearError = () => {
    errorBox.hidden = true;
    errorBox.textContent = "";
  };
  const setCollapsed = () => panel.classList.remove("ht-active");
  const setExpanded = () => panel.classList.add("ht-active");
  const resetEnableBtn = () => {
    starting = false;
    enableBtn.textContent = "Head tracking";
  };

  function startHeadLoop() {
    const draw = () => {
      const p = headTracking.latestPose;
      // Dim the wireframe when poses stop arriving (face lost) — this replaces
      // the old "looking for face…" status text.
      const fresh = performance.now() - headTracking.lastPoseAt < 500;
      renderHead(headCtx, p?.yaw ?? 0, p?.pitch ?? 0, p?.roll ?? 0, fresh ? 1 : 0.35);
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
  }
  function stopHeadLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    headCtx.clearRect(0, 0, HEAD_W, HEAD_H);
  }

  async function enable() {
    if (starting || headTracking.enabled) return;
    clearError();
    starting = true;
    enableBtn.textContent = "starting…";

    // Camera permission is its own failure mode — handle denial in-panel.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    } catch (err) {
      showError("Camera access was blocked. Allow the camera and try again.");
      resetEnableBtn();
      return;
    }

    try {
      preview.srcObject = stream;
      await preview.play();
      // Lazy-load voltface (+ MediaPipe) only now.
      const { HeadTracker } = await import("voltface");
      tracker = new HeadTracker({ wasmBasePath, modelAssetPath });
      await tracker.init();
      // Auto-calibrate at the opt-in moment so poses are clean deltas.
      let pendingCalibrate = true;
      unsub = tracker.onPose((pose) => {
        if (pendingCalibrate) {
          tracker.calibrate();
          pendingCalibrate = false;
          return; // skip this absolute frame; next is relative to neutral
        }
        headTracking.latestPose = pose;
        headTracking.lastPoseAt = performance.now();
      });
      headTracking.recenter = () => {
        tracker?.calibrate();
      };
      await tracker.start({ video: preview });
    } catch (err) {
      console.error("[head-tracking] failed to start:", err);
      showError("Could not start head tracking.");
      await disable();
      return;
    }

    headTracking.enabled = true;
    setExpanded();
    startHeadLoop();
    resetEnableBtn();
  }

  async function disable() {
    headTracking.enabled = false;
    headTracking.latestPose = null;
    headTracking.lastPoseAt = 0;
    headTracking.recenter = () => {};
    stopHeadLoop();
    if (unsub) unsub();
    unsub = null;
    if (tracker) tracker.dispose();
    tracker = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    preview.srcObject = null;
    setCollapsed();
  }

  enableBtn.addEventListener("click", enable);
  el("ht-disable").addEventListener("click", disable);
  el("ht-recenter").addEventListener("click", () => headTracking.recenter());

  // 'C' recenters while enabled. Space/WASD/M/X are claimed by world.js; C is free.
  window.addEventListener("keydown", (e) => {
    if (!headTracking.enabled) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.code === "KeyC") headTracking.recenter();
  });

  setCollapsed();
}
