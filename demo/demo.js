/* The demo page's whole client. One entity per visitor: the
   microphone goes up as that entity's source, and the space's
   binaural render for that same entity comes back down. A hand port
   of lasa/typescript/examples/minimal to plain JS.

   Development overrides via query parameters:
     ?url=https://localhost:4443/lasa&space=main&hash=<base64>     */

import {
  LasaClient,
  Store,
  baseView,
  loudnessToDBFS,
} from '@panaudia/lasa-client';

const params = new URLSearchParams(location.search);
const SPACE_URL = params.get('url') ?? 'https://test.panaudia.com/lasa';
const SPACE_ID = params.get('space') ?? 'main';
const CERT_HASH = params.get('hash') ?? undefined;

const $ = (id) => document.getElementById(id);
const form = $('join-form');
const nameInput = $('name');
const joinButton = $('join');
const leaveButton = $('leave');
const status = $('status');
const spaceView = $('space-view');
const spaceUsers = $('space-users');
const supportNote = $('support-note');
const swatches = $('swatches');

let session = null;

// The colour you pick rides on the entity as the base-profile attr
// `colour`, a six-digit hex string without the hash, which is what
// the 3D page publishes and reads too. Fixed palette, drawn as dots.
const PALETTE = ['2f56ee', '00bbff', '1fa87a', 'e0a800', 'ef6c2a', 'd63a5c', '8a4fd6', '5c6b7a'];
const HEX6 = /^[0-9a-f]{6}$/i;

for (const [i, c] of PALETTE.entries()) {
  const label = document.createElement('label');
  label.className = 'swatch';
  label.style.setProperty('--c', `#${c}`);
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'colour';
  input.value = c;
  input.checked = i === Math.floor(Math.random() * PALETTE.length);
  label.append(input);
  swatches.append(label);
}
if (!swatches.querySelector('input:checked')) swatches.querySelector('input').checked = true;

function chosenColour() {
  return swatches.querySelector('input:checked')?.value ?? PALETTE[0];
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

// The honest capability check, before anyone types a name.
function unsupportedReason() {
  if (typeof WebTransport === 'undefined')
    return 'This browser has no WebTransport. Chrome, Edge and Firefox current versions work; Safari does not yet.';
  if (!crossOriginIsolated)
    return 'This page needs cross-origin isolation and did not get it. A hard reload usually fixes it (the first visit installs a service worker).';
  return null;
}

// The demo needs globally unique ids and people will all be called
// alice: the id is a slug plus a random suffix, the typed name rides
// on the entity for display.
function makeIds(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'guest';
  const suffix = Math.random().toString(36).slice(2, 6);
  const clientId = `${slug}-${suffix}`;
  return { clientId, entityId: `${clientId}-voice` };
}

// Everyone joins on a circle so two visitors are audibly apart.
// LASA axes (docs/coordinates.md): x forward, y left, z up, so the
// floor is the (x, y) plane. Metres; the yaw faces the origin, as
// angle − π rather than angle + π because the wire clamps angles
// outside (−π, π] instead of wrapping them.
function poseOnCircle() {
  const angle = Math.random() * Math.PI * 2;
  return { x: 5 * Math.cos(angle), y: 5 * Math.sin(angle), z: 0, yaw: angle - Math.PI, pitch: 0, roll: 0 };
}

async function join() {
  const name = nameInput.value.trim();
  const colour = chosenColour();
  const { clientId, entityId } = makeIds(name);
  setStatus('connecting');

  const client = await LasaClient.connect({
    url: SPACE_URL,
    spaceId: SPACE_ID,
    clientId,
    entities: [{ id: entityId, name }],
    serverCertificateHashBase64: CERT_HASH,
    debug: params.has('debug'),
    onClosed: (info) => {
      setStatus(`closed${info.reason ? `: ${info.reason}` : ''}`);
      void teardown();
    },
  });

  try {
    // A 48 kHz context is required (Opus at 48 kHz in 5 ms frames).
    // Processing is off: this is a spatial mix, not a phone call,
    // which is also why the page insists on headphones.
    const ctx = new AudioContext({ sampleRate: 48000 });
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const myPose = poseOnCircle();
    const capture = await client.startCapture(entityId, {
      source: ctx.createMediaStreamSource(mic),
      pose: myPose,
    });

    const player = await client.playSink(entityId, 'binaural');

    const roster = await client.subscribeRoster(render);

    const store = await Store.create(['lasa.']);
    const sync = client.syncState(store);
    const view = baseView(store);
    await sync.settled();

    const me = await client.entity(entityId);
    await me.setAttrs({ colour });

    session = { client, entityId, ctx, capture, player, roster, sync, view, myPose, colour };
    joinButton.disabled = true;
    leaveButton.disabled = false;
    nameInput.disabled = true;
    swatches.disabled = true;
    setStatus(`in the space as ${name}`);
    render();
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

// dBFS to a 0..1 level: -50 dBFS and below is silence, 0 dBFS full.
function level(db) {
  if (db === null) return 0;
  return Math.min(1, Math.max(0, (db + 50) / 50));
}

// The top-down view, looking down the z (up) axis, drawn the way the
// ambisonic convention reads: x (forward) runs up the page and y
// runs to the left, so positive yaw turns anticlockwise on screen
// exactly as it does in the space. SVG's x grows right and y grows
// down, hence both axes negate: screen x = −y, screen y = −x.
function render() {
  if (!session) return;
  const { roster, view, entityId } = session;
  const users = roster
    .snapshot()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => {
      const entity = view.entity(e.id);
      const name = entity?.name ?? e.id;
      const me = e.id === entityId;
      // Our own colour is known locally before the state echo lands;
      // peers without one (or with junk) fall through to the CSS default.
      const c = me ? session.colour : entity?.attrs?.colour;
      const tint = typeof c === 'string' && HEX6.test(c) ? ` style="--c:#${c}"` : '';
      const lv = level(loudnessToDBFS(e.loudness));
      // Our own glyph draws from the local pose, so dragging tracks
      // the pointer instead of the presence echo.
      const pose = me ? session.myPose : e.pose;
      const x = -pose.y, y = -pose.x, yaw = pose.yaw;
      // The caret is drawn pointing up the page (yaw 0 = +x) and
      // rotated into the facing; SVG rotate is clockwise, yaw is
      // anticlockwise, hence the sign.
      const deg = (-yaw * 180 / Math.PI).toFixed(1);
      // Glyphs are map markers, not to scale: a person draws at 1.5 m
      // radius so they stay legible in the 60 m view.
      const glow = lv > 0 ? `<circle class="glow" r="${(1.86 + 3.0 * lv).toFixed(2)}"></circle>` : '';
      const handle = me ? `<circle class="facing-hit" cy="-2.37" r="1.5"></circle>` : '';
      return `<g class="user${me ? ' me' : ''}"${tint} transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">` +
        glow +
        `<g class="heading" transform="rotate(${deg})">` +
        `<path class="facing" d="M -0.72 -1.98 L 0 -2.76 L 0.72 -1.98"></path>` +
        handle +
        `</g>` +
        `<circle class="body" r="1.5"></circle>` +
        `<text y="3.6">${escapeHtml(name)}</text>` +
        `</g>`;
    });
  spaceUsers.innerHTML = users.join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Dragging our own circle moves us; dragging its caret turns us.
// Screen → world is the view mapping inverted: wx = −sy, wy = −sx.
// The pose goes out with the next audio frames via capture.setPose.
let drag = null; // { mode: 'move' | 'rotate' }

function pointerWorld(ev) {
  const m = spaceView.getScreenCTM().inverse();
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m);
  return { wx: -p.y, wy: -p.x };
}

spaceView.addEventListener('pointerdown', (ev) => {
  if (!session || !ev.target.closest('.user.me')) return;
  drag = { mode: ev.target.classList.contains('facing-hit') ? 'rotate' : 'move' };
  spaceView.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
spaceView.addEventListener('pointermove', (ev) => {
  if (!drag || !session) return;
  const { wx, wy } = pointerWorld(ev);
  const pose = session.myPose;
  if (drag.mode === 'move') {
    // Positions are unbounded in LASA; the clamp just keeps our
    // circle inside the visible 60 m.
    pose.x = Math.max(-29.5, Math.min(29.5, wx));
    pose.y = Math.max(-29.5, Math.min(29.5, wy));
  } else {
    // Point the caret at the pointer. atan2 keeps yaw in (−π, π].
    pose.yaw = Math.atan2(wy - pose.y, wx - pose.x);
  }
  session.capture.setPose(pose);
  render();
});
const endDrag = (ev) => {
  if (!drag) return;
  drag = null;
  spaceView.releasePointerCapture?.(ev.pointerId);
};
spaceView.addEventListener('pointerup', endDrag);
spaceView.addEventListener('pointercancel', endDrag);

async function teardown() {
  const s = session;
  session = null;
  joinButton.disabled = false;
  leaveButton.disabled = true;
  nameInput.disabled = false;
  swatches.disabled = false;
  spaceUsers.innerHTML = '';
  if (!s) return;
  await s.client.close(); // stops capture, playout, presence and state
  await s.ctx.close();
}

const reason = unsupportedReason();
if (reason) {
  supportNote.textContent = reason;
  supportNote.hidden = false;
  joinButton.disabled = true;
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault(); // a user gesture, which the AudioContext needs
  join().catch((e) => {
    setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`, true);
    console.error(e);
  });
});
leaveButton.addEventListener('click', () => {
  teardown().then(() => setStatus('left'));
});
