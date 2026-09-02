interface HeadPose {
    /** `performance.now()` at the time the frame was processed. */
    timestamp: number;
    /** Rotation around the vertical axis (shake-head-no), radians. */
    yaw: number;
    /** Rotation around the lateral axis (nod-yes), radians. */
    pitch: number;
    /** Rotation around the forward axis (tilt-to-shoulder), radians. */
    roll: number;
    /**
     * Raw 4x4 face-to-camera transformation, column-major (WebGL convention).
     * Feed directly into `three.js`' `Matrix4.fromArray()` or a WebGL uniform.
     */
    matrix: Float32Array;
}
interface HeadTrackerOptions {
    /** Base URL for the MediaPipe WASM runtime. Defaults to jsDelivr CDN. */
    wasmBasePath?: string;
    /** URL for the `.task` face-landmarker model. Defaults to Google's hosted model. */
    modelAssetPath?: string;
    /** `"GPU"` (WebGL) or `"CPU"` (WASM). Defaults to GPU with automatic fallback. */
    delegate?: "GPU" | "CPU";
    /** 0–1, how confident detection must be to emit a pose. */
    minDetectionConfidence?: number;
    /** 0–1, how confident tracking must be to keep emitting between detections. */
    minTrackingConfidence?: number;
}
interface StartOptions {
    /** A `<video>` element that is already playing a webcam stream. */
    video: HTMLVideoElement;
    /** Optional abort signal; aborting stops the tracker. */
    signal?: AbortSignal;
}
type PoseListener = (pose: HeadPose) => void;
type Unsubscribe = () => void;

declare class HeadTracker {
    private readonly options;
    private landmarker;
    private video;
    private rafHandle;
    private running;
    private latestPose;
    private latestRawMatrix;
    private referenceMatrix;
    private lastVideoTime;
    private readonly listeners;
    constructor(options?: HeadTrackerOptions);
    init(): Promise<void>;
    start(opts: StartOptions): Promise<void>;
    stop(): void;
    dispose(): void;
    getLatestPose(): HeadPose | null;
    onPose(listener: PoseListener): Unsubscribe;
    /**
     * Capture the current head orientation as the neutral zero. Subsequent poses
     * are reported relative to this reference: if the user holds the same pose
     * they calibrated at, yaw/pitch/roll will read 0. Returns `false` if no pose
     * has been observed yet.
     */
    calibrate(): boolean;
    /** Discard any calibration; poses revert to raw camera-frame orientation. */
    resetCalibration(): void;
    get isCalibrated(): boolean;
    private scheduleFrame;
    private tick;
    private handleResult;
}

interface EulerYXZ {
    yaw: number;
    pitch: number;
    roll: number;
}
/**
 * Decompose the rotation part of a 4x4 matrix into YXZ intrinsic Tait-Bryan
 * angles: apply yaw (around Y), then pitch (around X), then roll (around Z).
 *
 * This matches the natural head-pose decomposition where yaw = shake-head-no,
 * pitch = nod-yes, roll = tilt-to-shoulder. Outputs are in radians.
 *
 * Math: for R = Ry * Rx * Rz we have R[1][2] = -sin(pitch),
 * R[0][2] = sin(yaw)*cos(pitch), R[2][2] = cos(yaw)*cos(pitch),
 * R[1][0] = cos(pitch)*sin(roll), R[1][1] = cos(pitch)*cos(roll).
 */
declare const extractEulerYXZ: (m: ArrayLike<number>) => EulerYXZ;
/** Radians → degrees, for display. */
declare const toDegrees: (radians: number) => number;
/**
 * Produce a 4x4 column-major matrix whose rotation part is `refᵀ · cur`,
 * i.e. the rotation of `cur` expressed in the frame defined by `ref`.
 *
 * Used for calibration: if `ref` is captured as the user's neutral pose, then
 * `relativeRotation(ref, cur)` yields the deviation from neutral. When
 * `cur === ref`, the result is the identity (yaw = pitch = roll = 0).
 *
 * Only the upper-left 3x3 is meaningful; translation is zeroed and the
 * homogeneous element is 1.
 */
declare const relativeRotation: (ref: ArrayLike<number>, cur: ArrayLike<number>) => Float32Array;

declare const VERSION = "0.0.1";

export { type EulerYXZ, type HeadPose, HeadTracker, type HeadTrackerOptions, type PoseListener, type StartOptions, type Unsubscribe, VERSION, extractEulerYXZ, relativeRotation, toDegrees };
