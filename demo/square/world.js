/* The 3D town square. A port of the old panaudia.com world.js: the
   three.js scene, movement and minimap are unchanged; the network
   seam is rewritten from the old @panaudia/client onto
   @panaudia/lasa-client, the same way as the simple demo's demo.js.

   Scene units are centimetres (a hangover worth keeping: all the
   tuned constants assume it); LASA is metres, so poses scale by 100
   at the seam. The official converters handle the axis change
   (three.js y-up to LASA x-forward/y-left/z-up).

   Development overrides via query parameters, same as the simple demo:
     ?url=https://localhost:4443/lasa&space=main&hash=<base64>       */

import * as THREE from 'three';

import {PointerLockControls} from 'three/addons/controls/PointerLockControls.js';
import {SwipeControls} from 'three/addons/controls/SwipeControls.js';
import {CSS2DRenderer} from 'three/addons/renderers/CSS2DRenderer.js';
import {
    LasaClient,
    Store,
    baseView,
    loudnessToDBFS,
    threejsToLasa,
    lasaToThreejs,
} from '@panaudia/lasa-client';
import {headTracking} from 'head-tracking';

const params = new URLSearchParams(location.search);
const SPACE_URL = params.get('url') ?? 'https://test.panaudia.com/lasa';
const SPACE_ID = params.get('space') ?? 'main';
const CERT_HASH = params.get('hash') ?? undefined;

let camera, mapCamera, scene, renderer, controls, helper;
let labelRenderer;
const objects = [];
let nodes = undefined;
let raycaster;
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let canJump = false;
let previousRotation = new THREE.Euler();
let previousPosition = new THREE.Vector3();
let cube_size;
let mini_border = 20.0;
let speed = 2.5;
let background;
let masterVolume = -1;     // playout level while fading in, -1 when not joined
let targetVolume = 1.0;    // the slider
let micMuted = false;
let cube_cm;
const EYE_HEIGHT = 100; // cm above the floor; the camera rides at y = 0

let errorMessage;
let prevTime = performance.now();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
var isTouchDevice;
var isConnected;
var useLabels;
var miniMapSize;
var clickAdded;

let world_elements;
let session = null;   // { client, entityId, ctx, mic, capture, player, roster, sync, view, me, ghosted }

// Picking spheres with the pointer free (desktop only).
const clickRaycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredId = null;
let meSpheres = [];   // own-avatar meshes on the camera, removed on leave

// Scratch objects for composing the head-tracking rotation into the sent pose.
const _htMat = new THREE.Matrix4();
const _htFaceQ = new THREE.Quaternion();
const _htCamQ = new THREE.Quaternion();
const _htSendQ = new THREE.Quaternion();
const _htSendEuler = new THREE.Euler();
const _htCurrentQ = new THREE.Quaternion();   // smoothed / decayed head delta
const _htIdentityQ = new THREE.Quaternion();  // neutral target
const HEAD_STALE_MS = 200;       // no pose for this long => face treated as lost
const HEAD_SLERP_FRESH = 0.4;    // ease toward the live head delta (responsive)
const HEAD_SLERP_DECAY = 0.06;   // ease back to neutral when the face is lost

// ── The LASA seam ───────────────────────────────────────────────────

function unsupportedReason() {
    if (typeof WebTransport === 'undefined')
        return 'This browser has no WebTransport. Chrome, Edge and Firefox current versions work; Safari does not yet.';
    if (!crossOriginIsolated)
        return 'This page needs cross-origin isolation and did not get it. A hard reload usually fixes it (the first visit installs a service worker).';
    return null;
}

// Ids must be globally unique and everyone will be called alice: a
// slug plus a random suffix, the typed name rides on the entity.
function makeIds(name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'guest';
    const suffix = Math.random().toString(36).slice(2, 6);
    const clientId = `${slug}-${suffix}`;
    return { clientId, entityId: `${clientId}-voice` };
}

// The rotation we broadcast (and listen with). Head tracking off: the
// mouse-driven camera rotation. On: the face rotation composed onto
// the camera heading as a local, head-relative turn. The face
// quaternion is built straight from the pose matrix and flattened to
// an XYZ Euler only here, at the threejsToLasa boundary.
function currentSendRotation() {
    if (!headTracking.enabled) {
        _htCurrentQ.identity(); // so a later Enable starts from neutral
        return camera.rotation;
    }

    const pose = headTracking.latestPose;
    const fresh = pose && (performance.now() - headTracking.lastPoseAt < HEAD_STALE_MS);

    if (fresh) {
        _htFaceQ.setFromRotationMatrix(_htMat.fromArray(pose.matrix));
        // MediaPipe's face frame has +Z out of the face toward the
        // camera, the opposite of three.js's -Z-forward camera frame:
        // a 180 degree turn about Y. Re-expressing the face rotation
        // in the camera frame keeps yaw and negates pitch and roll,
        // which on a unit quaternion is negating x and z.
        _htFaceQ.x = -_htFaceQ.x;
        _htFaceQ.z = -_htFaceQ.z;
        _htCurrentQ.slerp(_htFaceQ, HEAD_SLERP_FRESH);
    } else {
        // Face lost (or none yet): ease back to identity so the pose
        // settles onto the mouse heading instead of freezing.
        _htCurrentQ.slerp(_htIdentityQ, HEAD_SLERP_DECAY);
    }

    camera.getWorldQuaternion(_htCamQ);
    _htSendQ.multiplyQuaternions(_htCamQ, _htCurrentQ);
    _htSendEuler.setFromQuaternion(_htSendQ, 'XYZ');
    return _htSendEuler;
}

function cameraPose() {
    const rot = currentSendRotation();
    return threejsToLasa(
        {x: camera.position.x / 100, y: camera.position.y / 100, z: camera.position.z / 100},
        {x: rot.x, y: rot.y, z: rot.z},
        rot.order);
}

// Muting keeps the capture running and sends silence: the pose still
// goes out on the audio frames, so a muted listener keeps moving.
window.toggleMic = () => {
    setMicMuted(!micMuted);
};

function setMicMuted(muted) {
    micMuted = muted;
    if (session !== null) {
        for (const track of session.mic.getAudioTracks()) { track.enabled = !muted; }
    }
    const link = document.getElementById('mic-toggle');
    link.textContent = muted ? 'UNMUTE' : 'MUTE';
    link.classList.toggle('mic-muted', muted);
    // Classes, not the hidden attribute: inline SVG ignores that.
    document.getElementById('mic-icon-on').classList.toggle('hidden', muted);
    document.getElementById('mic-icon-off').classList.toggle('hidden', !muted);
}

window.connect = async (attr) => {

    errorMessage = undefined;
    const ui = uiRefs();
    ui.spinner.classList = 'spinner';
    ui.connectButton.classList = 'hidden';
    ui.errorDiv.style.display = 'none';

    try {
        await join(attr);
        onJoined();
    } catch (e) {
        console.error(e);
        errorMessage = e instanceof Error ? e.message : String(e);
        showDisconnectedUI();
    }
};

window.disconnect = () => {
    void leave();
};

async function join(attr) {

    adjustSpawn();

    const { clientId, entityId } = makeIds(attr.name);

    const client = await LasaClient.connect({
        url: SPACE_URL,
        spaceId: SPACE_ID,
        clientId,
        entities: [{ id: entityId, name: attr.name }],
        serverCertificateHashBase64: CERT_HASH,
        onClosed: (info) => {
            if (info.reason) { errorMessage = info.reason; }
            void leave();
        },
    });

    try {
        // A 48 kHz context is required (Opus at 48 kHz in 5 ms
        // frames). Processing is off: this is a spatial mix, not a
        // phone call, which is why the page insists on headphones.
        const ctx = new AudioContext({ sampleRate: 48000 });
        const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const capture = await client.startCapture(entityId, {
            source: ctx.createMediaStreamSource(mic),
            pose: cameraPose(),
        });

        const player = await client.playSink(entityId, 'binaural');
        player.setVolume(0); // faded in by the animate loop

        const roster = await client.subscribeRoster(onRosterUpdate);

        const store = await Store.create(['lasa.']);
        const sync = client.syncState(store);
        const view = baseView(store);
        await sync.settled();

        // Colours ride on the entity as base-profile attrs, where the
        // old page put them in the connection's attribute tree.
        const me = await client.entity(entityId);
        await me.setAttrs({
            'inner-colour': attr.innerColour,
            'outer-colour': attr.outerColour,
        });

        session = { client, entityId, ctx, mic, capture, player, roster, sync, view, me, ghosted: new Set() };
        nodes = {};
        masterVolume = 0;
        setMicMuted(false);
        showIdentity(attr);
        world_elements.addMe(attr, camera, meSpheres);
        onRosterUpdate(); // render whoever was already here
    } catch (e) {
        await client.close().catch(() => {});
        throw e;
    }
}

async function leave() {
    const s = session;
    session = null;
    isConnected = false;
    masterVolume = -1;
    hideNodeMenu();
    removeAllSpheres();
    nodes = undefined;
    for (const mesh of meSpheres) { camera.remove(mesh); }
    meSpheres = [];
    showDisconnectedUI();
    if (!s) return;
    await s.client.close().catch(() => {}); // stops capture, playout, presence, state
    await s.ctx.close().catch(() => {});
}

// Presence drives the spheres: poses and loudness per entity, with
// names and colours read from the base-profile state view.
function onRosterUpdate() {
    if (session === null || nodes === undefined) { return; }

    const seen = new Set();
    for (const e of session.roster.snapshot()) {
        if (e.id === session.entityId) { continue; }
        seen.add(e.id);
        const entity = session.view.entity(e.id);
        const name = entity?.name ?? e.id;
        const attrs = entity?.attrs;
        const t = lasaToThreejs(e.pose);
        const position = new THREE.Vector3(t.position.x * 100, t.position.y * 100, t.position.z * 100);
        ensureSphere(e.id, position, t.rotation, e.loudness, name, attrs);
    }
    for (const id of Object.keys(nodes)) {
        if (!seen.has(id)) { removeSphere(id); }
    }
}

// The identity row in the in-world panel: the join card's avatar in
// miniature, and the name as typed.
function showIdentity(attr) {
    document.getElementById('me-avatar').style.backgroundColor = '#' + attr.outerColour;
    document.getElementById('me-avatar-inner').style.backgroundColor = '#' + attr.innerColour;
    document.getElementById('me-name').textContent = attr.name;
}

// ── Ghosting: a personal mute on one entity ─────────────────────────
// The profile's mute silences the pair both ways, so a ghosted person
// neither hears you nor is heard. The sphere goes faint but stays.

async function setGhosted(id, ghosted) {
    if (session === null) { return; }
    if (ghosted) { session.ghosted.add(id); } else { session.ghosted.delete(id); }
    if (nodes !== undefined && id in nodes) { world_elements.ghostNode(nodes[id], ghosted); }
    try {
        if (ghosted) { await session.me.mute(id); } else { await session.me.unmute(id); }
    } catch (e) {
        console.error(e);
    }
}

function showNodeMenu(id, x, y) {
    const node = nodes?.[id];
    if (node === undefined) { return; }
    const menu = document.getElementById('node-menu');
    const ghosted = session.ghosted.has(id);
    document.getElementById('node-menu-name').textContent = node.label.element.textContent || id;
    const button = document.getElementById('node-menu-ghost');
    button.textContent = ghosted ? 'Unghost' : 'Ghost';
    button.onclick = (e) => {
        e.preventDefault();
        void setGhosted(id, !ghosted);
        hideNodeMenu();
    };
    menu.classList.remove('hidden');
    // Beside the pointer, kept inside the window.
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x + 12, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y - h / 2, window.innerHeight - h - 8) + 'px';
}

function hideNodeMenu() {
    document.getElementById('node-menu').classList.add('hidden');
}

// With the pointer free, find the sphere under it (if any).
function onPointerMove(e) {
    if (session === null || nodes === undefined || isTouchDevice || controls.isLocked) {
        hoveredId = null;
        return;
    }
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    clickRaycaster.setFromCamera(mouse, camera);
    const hits = clickRaycaster.intersectObjects(Object.values(nodes).map((n) => n.obj), true);
    let id = null;
    for (let obj = hits[0]?.object; obj; obj = obj.parent) {
        if (obj.userData.entityId !== undefined) { id = obj.userData.entityId; break; }
    }
    hoveredId = id;
    document.body.style.cursor = id === null ? '' : 'pointer';
}

function uiRefs() {
    return {
        connectButton: document.getElementById('connect'),
        spinner: document.getElementById('spinner'),
        side: document.getElementById('side'),
        info: document.getElementById('info-box'),
        errorDiv: document.getElementById('error-block'),
        errorPara: document.getElementById('error-msg'),
        audioControls: document.getElementById('audio-controls'),
    };
}

function onJoined() {
    const ui = uiRefs();
    ui.spinner.classList = 'spinner hidden';
    ui.connectButton.classList = 'hidden';
    ui.side.style.display = 'none';
    ui.info.style.display = 'none';
    ui.audioControls.classList.remove('hidden');
    isConnected = true;
    onWindowResize();

    if (isTouchDevice) {
        controls.activate();
        document.getElementById('touch-move').style.display = 'block';
        document.getElementById('touch-look').style.display = 'block';
    } else {
        document.getElementById('instructions').style.display = 'block';
        addLockClick();
    }
}

function showDisconnectedUI() {
    const ui = uiRefs();
    ui.spinner.classList = 'spinner hidden';
    ui.connectButton.classList = '';
    ui.side.style.display = 'block';
    ui.audioControls.classList.add('hidden');

    if (errorMessage !== undefined) {
        ui.errorPara.innerText = errorMessage;
        ui.errorDiv.style.display = 'block';
        ui.info.style.display = 'none';
    } else {
        ui.errorDiv.style.display = 'none';
        ui.info.style.display = 'block';
    }
}

// ── The three.js world (unchanged from the old page below here,
//    apart from grid scaling and label cleanup) ─────────────────────

function init(elements) {

    world_elements = elements;
    cube_size = world_elements.cubeSize;
    cube_cm = cube_size * 100;
    background = world_elements.backgroundColour;
    isConnected = false;
    clickAdded = false;
    useLabels = world_elements.useLabels;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(background);

    if (world_elements.doFog) {
        scene.fog = new THREE.Fog(background, 0, world_elements.fogDistance);
    }

    if (isTouchDevice) {
        camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, elements.distance);
    } else {
        camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1, elements.distance);
    }

    // Eye height is the origin: the floor sits 1 m below, so the pose
    // we publish has z = 0, the same as the 2D demo page's visitors.
    camera.position.y = 0;

    scene.add(camera);

    world_elements.adjustCamera(camera);

    mapCamera = elements.addMapCamera(scene, cube_cm, camera);

    world_elements.addLights(scene, background);

    addFloor(world_elements.floorShadow);

    world_elements.addLandscape(scene, cube_cm, objects);

    raycaster = new THREE.Raycaster();
    var rayPos = new THREE.Vector3();

    // Use y = 100 to ensure ray starts above terrain
    rayPos.set(0, 100, 0);
    var rayDir = new THREE.Vector3(0, -1, 0);
    raycaster.set(rayPos, rayDir);

    renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);

    renderer.domElement.id = "renderer";
    document.body.appendChild(renderer.domElement);

    if (useLabels) {
        addLabelRenderer();
    }

    renderer.shadowMap.enabled = elements.doShadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    if (isTouchDevice) {
        addTouchControls();
        miniMapSize = 150;
    } else {
        addControls();
        miniMapSize = world_elements.defaultMapSize;
    }

    window.addEventListener('resize', onWindowResize);
    window.addEventListener("deviceorientation", onDeviceOrientation);
    window.addEventListener('pointermove', onPointerMove);

    document.getElementById('volume').addEventListener('input', function () {
        targetVolume = this.value / 100;
        if (masterVolume >= 0) {
            masterVolume = targetVolume; // no fade when the user drags
        }
    });

    const reason = unsupportedReason();
    if (reason) {
        errorMessage = reason;
        const ui = uiRefs();
        ui.errorPara.innerText = reason;
        ui.errorDiv.style.display = 'block';
        ui.info.style.display = 'none';
        ui.connectButton.classList = 'disabled';
        window.lasaUnsupported = true;
    }
}

function addLabelRenderer() {
    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    document.body.appendChild(labelRenderer.domElement);
}

function moveTouchPad() {

    if (controls.moveUsed) {
        const pad = document.getElementById('touch-move');
        pad.style.setProperty("--move-decoration-display", "none");
        if (controls.moveTouchId === undefined) {
            pad.style.display = "none";
        } else {
            pad.style.left = (controls.moveX - 40) + 'px';
            pad.style.top = (controls.moveY - 40) + 'px';
            pad.style.display = "block";
            document.getElementById('touch-arrow-move-up').style.display = moveForward ? "block" : "none";
            document.getElementById('touch-arrow-move-down').style.display = moveBackward ? "block" : "none";
            document.getElementById('touch-arrow-move-left').style.display = moveLeft ? "block" : "none";
            document.getElementById('touch-arrow-move-right').style.display = moveRight ? "block" : "none";
        }
    }
}

function lookTouchPad() {

    if (controls.turnUsed) {
        const pad = document.getElementById('touch-look');
        pad.style.setProperty("--look-decoration-display", "none");
        if (controls.turnTouchId === undefined) {
            pad.style.display = "none";
        } else {
            pad.style.left = (controls.turnX - 40) + 'px';
            pad.style.top = (controls.turnY - 40) + 'px';
            pad.style.display = "block";
            document.getElementById('touch-arrow-look-up').style.display = controls.lookingUp ? "block" : "none";
            document.getElementById('touch-arrow-look-down').style.display = controls.lookingDown ? "block" : "none";
            document.getElementById('touch-arrow-look-left').style.display = controls.lookingLeft ? "block" : "none";
            document.getElementById('touch-arrow-look-right').style.display = controls.lookingRight ? "block" : "none";
        }
    }
}

function addFloor(floorShadow) {

    const planeGeometry = new THREE.PlaneGeometry(cube_cm, cube_cm);
    planeGeometry.rotateX(-Math.PI / 2);
    const planeMaterial = new THREE.ShadowMaterial({color: 0x000000, opacity: 0.4});
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.position.y = -EYE_HEIGHT;
    plane.receiveShadow = floorShadow;
    objects.push(plane);
    scene.add(plane);

    // 1 m minor cells, 5 m major cells (the world is cube_size m across).
    helper = new THREE.GridHelper(cube_cm, cube_size);
    helper.position.y = -EYE_HEIGHT + 1;
    helper.material.opacity = 0.5;
    helper.material.transparent = true;
    scene.add(helper);

    let helper2 = new THREE.GridHelper(cube_cm, cube_size / 5);
    helper2.position.y = -EYE_HEIGHT + 1;
    helper2.material.opacity = 0.8;
    helper2.material.transparent = true;
    scene.add(helper2);
}

function addControls() {
    controls = new PointerLockControls(camera, document.body);

    controls.addEventListener('change', function () {
        move();
    });

    controls.addEventListener('lock', function () {
        hideNodeMenu();
        hoveredId = null;
        document.body.style.cursor = '';
    });

    controls.addEventListener('unlock', function () {
        addLockClick();
    });

    const onKeyDown = function (event) {

        switch (event.code) {

            case 'ArrowUp':
            case 'KeyW':
                moveForward = true;
                break;

            case 'ArrowLeft':
            case 'KeyA':
                moveLeft = true;
                break;

            case 'ArrowDown':
            case 'KeyS':
                moveBackward = true;
                break;

            case 'ArrowRight':
            case 'KeyD':
                moveRight = true;
                break;

            case 'KeyX':
                document.getElementById('instructions').style.display = 'none';
                break;

            case 'KeyM':
                if (session !== null) { setMicMuted(!micMuted); }
                break;

            case 'Space':
                if (canJump === true) velocity.y += 150;
                canJump = false;
                break;
        }
    };

    const onKeyUp = function (event) {
        switch (event.code) {

            case 'ArrowUp':
            case 'KeyW':
                moveForward = false;
                break;

            case 'ArrowLeft':
            case 'KeyA':
                moveLeft = false;
                break;

            case 'ArrowDown':
            case 'KeyS':
                moveBackward = false;
                break;

            case 'ArrowRight':
            case 'KeyD':
                moveRight = false;
                break;
        }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
}

function addTouchControls() {
    controls = new SwipeControls(camera, renderer.domElement);

    controls.addEventListener('change', function () {
        moveForward = controls.Forward;
        moveBackward = controls.Backward;
        moveLeft = controls.Left;
        moveRight = controls.Right;
    });
}

function adjustSpawn() {
    while (true) {
        const lookat = world_elements.adjustPosition(controls.getObject().position);
        const intersections = getTerrainIntersections();
        if (intersections.length > 0) {
            if (lookat) {
                controls.getObject().lookAt(new THREE.Vector3(0, 0, 0));
            }
            return;
        }
    }
}

// A click on a sphere opens its menu; anywhere else locks the pointer.
function onSceneClick(event) {
    if (isTouchDevice) { return; }
    if (hoveredId !== null) {
        showNodeMenu(hoveredId, event.clientX, event.clientY);
    } else {
        hideNodeMenu();
        controls.lock();
    }
}

function addLockClick() {

    if (!clickAdded) {
        clickAdded = true;
        renderer.domElement.addEventListener('click', onSceneClick);
        if (useLabels) {
            labelRenderer.domElement.addEventListener('click', onSceneClick);
        }
    }
}

function ensureSphere(id, position, rotation, loudness, name, attrs) {
    if (!(id in nodes)) { addSphere(id, position); }
    world_elements.styleNode(nodes[id], name, attrs);
    moveSphere(id, position, rotation);
    updateVolume(id, loudness);
}

function removeSphere(id) {
    const node = nodes[id];
    if (node === undefined) { return; }
    if (node.label) {
        node.obj.remove(node.label);
        node.label.element.remove();
    }
    scene.remove(node.obj);
    delete nodes[id];
}

function removeAllSpheres() {
    if (nodes === undefined) { return; }
    for (const id of Object.keys(nodes)) {
        removeSphere(id);
    }
    nodes = {};
}

function updateVolume(id, loudness) {

    if (nodes[id].ghosted) { return; }

    const db = loudnessToDBFS(loudness);
    const amp = db === null ? 0 : Math.pow(10, db / 20);
    var op = (Math.log10(amp * 1000.0) - 1.4);
    if (op < 0 || !isFinite(op)) { op = 0; }
    op = op + 0.2;
    if (nodes[id].fade < 1.0) {
        nodes[id].mat.opacity = nodes[id].fade;
    } else {
        nodes[id].mat.opacity = op;
    }
}

function addSphere(id, position) {

    const node = world_elements.makeNode();
    node.mat.opacity = 0;
    node.obj.position.copy(position);
    node.obj.userData.entityId = id; // for picking
    scene.add(node.obj);

    nodes[id] = {
        ...node,
        "fade": 0,
        "target": position.clone(),
        "target_rotation": new THREE.Vector3(0.0, 0.0, 0.0)
    };
    world_elements.ghostNode(nodes[id], session.ghosted.has(id));
}

function moveSphere(id, position, rotation) {
    nodes[id].target = position;
    nodes[id].target_rotation = rotation;
}

function onDeviceOrientation() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (useLabels) {
        labelRenderer.setSize(window.innerWidth, window.innerHeight);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight - 1);
    if (useLabels) {
        labelRenderer.setSize(window.innerWidth, window.innerHeight);
    }
}

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();

    if (isTouchDevice) {
        if (controls.isActive() === true) {
            animateControls(time);
            moveTouchPad();
            lookTouchPad();
        }
    } else {
        if (controls.isLocked === true) {
            animateControls(time);
        }
    }

    // Head tracking must keep broadcasting while the pointer is not
    // locked (operating the panel needs a free pointer). When locked,
    // animateControls() -> move() already covers it.
    if (headTracking.enabled && session !== null && !isTouchDevice && !controls.isLocked) {
        move();
    }

    animateNodes(time);

    if (session !== null && masterVolume >= 0) {
        if (masterVolume < targetVolume) {
            masterVolume = Math.min(targetVolume, masterVolume + 0.02);
        } else {
            masterVolume = targetVolume;
        }
        session.player.setVolume(masterVolume);
    }

    prevTime = time;
    render();
}

function render() {
    let w = window.innerWidth, h = window.innerHeight;

    renderer.clear();
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, camera);

    if (useLabels) {
        labelRenderer.render(scene, camera);
    }

    if (isConnected) {
        if (helper !== undefined) {
            helper.visible = world_elements.showMinorGrid;
        }

        renderer.clearDepth();
        renderer.setScissorTest(true);

        world_elements.clipMapCamera(renderer, mini_border, w, h, miniMapSize);

        renderer.render(scene, mapCamera);
        renderer.setScissorTest(false);
        if (helper !== undefined) {
            helper.visible = true;
        }
    }
}

function animateNodes(time) {

    for (let id in nodes) {

        let node = nodes[id];

        let dx = node.target.x - node.obj.position.x;
        let dy = node.target.y - node.obj.position.y;
        let dz = node.target.z - node.obj.position.z;

        if (node.fade < 1) {
            node.fade += 0.02;
        }

        if (Math.abs(dx) > 0.001) {
            node.obj.position.x += dx / 20;
        }

        if (Math.abs(dy) > 0.001) {
            node.obj.position.y += dy / 20;
        }

        if (Math.abs(dz) > 0.001) {
            node.obj.position.z += dz / 20;
        }

        node.obj.rotation.x = node.target_rotation.x;
        node.obj.rotation.y = node.target_rotation.y;
        node.obj.rotation.z = node.target_rotation.z;
    }
}

function move(force = false) {

    if (session === null) { return; }

    let dp = 0.01;
    let dr = 0.0001;

    // Deadband on the composed rotation, so a head turn with the
    // camera otherwise still is detected and sent.
    const rot = currentSendRotation();

    let dpx = Math.abs(camera.position.x - previousPosition.x);
    let dpz = Math.abs(camera.position.z - previousPosition.z);
    let drx = Math.abs(rot.x - previousRotation.x);
    let dry = Math.abs(rot.y - previousRotation.y);
    let drz = Math.abs(rot.z - previousRotation.z);

    if (dpx > dp || dpz > dp || drx > dr || dry > dr || drz > dr || force) {
        // Wait-free: the freshest pose is stamped on the next audio frame.
        session.capture.setPose(cameraPose());
    }
    previousPosition.copy(camera.position);
    previousRotation.copy(rot);
}

function tooCloseToOthers() {
    const pos = controls.getObject().position.clone();
    for (let id in nodes) {
        let node = nodes[id];
        let distance = pos.distanceTo(node.obj.position);
        world_elements.nodeDistance(node, distance);
        if (distance < 40) {
            return true;
        }
    }
    return false;
}

function getTerrainIntersections() {
    raycaster.ray.origin.copy(controls.getObject().position);
    return raycaster.intersectObjects(objects, false);
}

function animateControls(time) {

    canJump = false;

    const xbefore = controls.getObject().position.x;
    const zbefore = controls.getObject().position.z;
    const tooClose1 = tooCloseToOthers();

    const intersections = getTerrainIntersections();
    const onObject = intersections.length > 0;
    const delta = (time - prevTime) / 1000;

    if (onObject) {
        const ydiff = intersections[0].distance - EYE_HEIGHT;
        if (Math.abs(ydiff) > 2) {
            velocity.y -= 9.8 * ydiff * delta * 1.0;

            if (velocity.y < -250) {
                velocity.y = -250;
            }
        } else {
            canJump = true;
            velocity.y = Math.max(0, velocity.y);
        }

    } else {
        velocity.y = 0;
    }

    velocity.x -= velocity.x * speed * delta;
    velocity.z -= velocity.z * speed * delta;
    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveRight) - Number(moveLeft);
    direction.normalize();

    if (moveForward || moveBackward) velocity.z -= direction.z * 400.0 * delta;
    if (moveLeft || moveRight) velocity.x -= direction.x * 400.0 * delta;

    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);

    controls.getObject().position.y += (velocity.y * delta);

    const intersections2 = getTerrainIntersections();
    const onObject2 = intersections2.length > 0;
    const tooClose2 = tooCloseToOthers();

    if (!onObject2 || (!tooClose1 && tooClose2)) {
        controls.getObject().position.setX(xbefore);
        controls.getObject().position.setZ(zbefore);
        velocity.x = 0;
        velocity.z = 0;
    }

    world_elements.animateMapCamera(camera, mapCamera);
    move();
}

isTouchDevice = Boolean(navigator.maxTouchPoints || 'ontouchstart' in document.documentElement);

export const init_3d = init;
export const animate_3d = animate;
