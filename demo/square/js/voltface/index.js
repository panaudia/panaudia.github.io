// GENERATED from voltface@d7b4ffc-dirty by voltface/scripts/sync-to-lark.mjs — do not edit.
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

// src/head-tracker.ts

// src/matrix.ts
var el = (m, r, c) => {
  const v = m[c * 4 + r];
  return v ?? 0;
};
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var extractEulerYXZ = (m) => {
  const pitch = Math.asin(clamp(-el(m, 1, 2), -1, 1));
  const cosPitch = Math.cos(pitch);
  if (Math.abs(cosPitch) > 1e-6) {
    return {
      pitch,
      yaw: Math.atan2(el(m, 0, 2), el(m, 2, 2)),
      roll: Math.atan2(el(m, 1, 0), el(m, 1, 1))
    };
  }
  return {
    pitch,
    yaw: Math.atan2(-el(m, 2, 0), el(m, 0, 0)),
    roll: 0
  };
};
var toDegrees = (radians) => radians * 180 / Math.PI;
var relativeRotation = (ref, cur) => {
  const out = new Float32Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += (ref[r * 4 + k] ?? 0) * (cur[c * 4 + k] ?? 0);
      }
      out[c * 4 + r] = sum;
    }
  }
  out[15] = 1;
  return out;
};

// src/head-tracker.ts
var DEFAULT_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
var DEFAULT_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
var HeadTracker = class {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  landmarker = null;
  video = null;
  rafHandle = null;
  running = false;
  latestPose = null;
  latestRawMatrix = null;
  referenceMatrix = null;
  lastVideoTime = -1;
  listeners = /* @__PURE__ */ new Set();
  async init() {
    if (this.landmarker) return;
    const resolver = await FilesetResolver.forVisionTasks(
      this.options.wasmBasePath ?? DEFAULT_WASM_BASE
    );
    this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: this.options.modelAssetPath ?? DEFAULT_MODEL,
        delegate: this.options.delegate ?? "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: this.options.minDetectionConfidence ?? 0.5,
      minTrackingConfidence: this.options.minTrackingConfidence ?? 0.5
    });
  }
  async start(opts) {
    await this.init();
    this.video = opts.video;
    this.running = true;
    opts.signal?.addEventListener("abort", () => this.stop(), { once: true });
    this.scheduleFrame();
  }
  stop() {
    this.running = false;
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }
  dispose() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.listeners.clear();
  }
  getLatestPose() {
    return this.latestPose;
  }
  onPose(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * Capture the current head orientation as the neutral zero. Subsequent poses
   * are reported relative to this reference: if the user holds the same pose
   * they calibrated at, yaw/pitch/roll will read 0. Returns `false` if no pose
   * has been observed yet.
   */
  calibrate() {
    if (!this.latestRawMatrix) return false;
    this.referenceMatrix = new Float32Array(this.latestRawMatrix);
    return true;
  }
  /** Discard any calibration; poses revert to raw camera-frame orientation. */
  resetCalibration() {
    this.referenceMatrix = null;
  }
  get isCalibrated() {
    return this.referenceMatrix !== null;
  }
  scheduleFrame() {
    this.rafHandle = requestAnimationFrame(this.tick);
  }
  tick = () => {
    if (!this.running) return;
    const video = this.video;
    const landmarker = this.landmarker;
    if (video && landmarker && video.readyState >= 2) {
      if (video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        this.handleResult(result, now);
      }
    }
    this.scheduleFrame();
  };
  handleResult(result, timestamp) {
    const matrices = result.facialTransformationMatrixes;
    if (!matrices || matrices.length === 0) return;
    const raw = matrices[0]?.data;
    if (!raw) return;
    const rawMatrix = new Float32Array(raw);
    this.latestRawMatrix = rawMatrix;
    const matrix = this.referenceMatrix ? relativeRotation(this.referenceMatrix, rawMatrix) : rawMatrix;
    const { yaw, pitch, roll } = extractEulerYXZ(matrix);
    const pose = { timestamp, yaw, pitch, roll, matrix };
    this.latestPose = pose;
    for (const listener of this.listeners) listener(pose);
  }
};

// src/index.ts
var VERSION = "0.0.1";

export { HeadTracker, VERSION, extractEulerYXZ, relativeRotation, toDegrees };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map