import {init_3d, animate_3d} from 'world';
import * as elements from 'elements';
import {initHeadTrackingUI} from 'head-tracking';

init_3d(elements);
animate_3d();

// Desktop with a camera only; the panel is simply absent otherwise.
// MediaPipe (about 15 MB of wasm and model) is fetched from the CDNs
// on first enable, not at page load; the version here must match the
// bundle in the import map.
initHeadTrackingUI({
    wasmBasePath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm',
    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
});
