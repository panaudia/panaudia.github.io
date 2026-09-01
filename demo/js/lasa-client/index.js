const PENDING_OBJECT_CAP = 512;
class SubgroupRouter {
  handlers = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  register(trackAlias, handler) {
    this.handlers.set(trackAlias, handler);
    const buffered = this.pending.get(trackAlias);
    if (buffered) {
      this.pending.delete(trackAlias);
      for (const { h, o } of buffered) handler(h, o);
    }
  }
  unregister(trackAlias) {
    this.handlers.delete(trackAlias);
    this.pending.delete(trackAlias);
  }
  /**
   * Route one object: to its handler, or into the bounded pending buffer
   * until a handler registers. The accept loop feeds this directly; in
   * worker mode, main feeds it with objects forwarded from the worker's
   * accept loop (same race, same buffer).
   */
  ingest(h, o) {
    const handler = this.handlers.get(h.trackAlias);
    if (handler) {
      handler(h, o);
      return;
    }
    const buf = this.pending.get(h.trackAlias) ?? [];
    if (buf.length < PENDING_OBJECT_CAP) buf.push({ h, o });
    this.pending.set(h.trackAlias, buf);
  }
}
const PENDING_DATAGRAM_MAX_BYTES = 1 * 1024 * 1024;
class DatagramRouter {
  handlers = /* @__PURE__ */ new Map();
  // Pre-handler buffer, FIFO across all aliases; oldest dropped when the byte cap
  // is exceeded. Cleared on clear().
  pending = [];
  pendingBytes = 0;
  /**
   * Register a handler for a track alias and drain any datagrams that arrived for
   * it before registration (the SUBSCRIBE_OK race), in arrival order.
   */
  register(trackAlias, handler) {
    this.handlers.set(trackAlias, handler);
    if (this.pending.length > 0) this.drainForAlias(trackAlias, handler);
  }
  /** Unregister a handler and discard any still-buffered datagrams for its alias. */
  unregister(trackAlias) {
    this.handlers.delete(trackAlias);
    if (this.pending.length > 0) this.discardForAlias(trackAlias);
  }
  /** Route a parsed datagram to its handler, or buffer it if none is registered yet. */
  ingest(d) {
    const handler = this.handlers.get(d.trackAlias);
    if (handler) {
      handler(d.payload, d.trackAlias, d.groupId, d.objectId);
    } else {
      this.bufferUnknown(d);
    }
  }
  // DatagramReceiver surface (same names as MoqConnection) so subscribers can take
  // either. These are the public aliases of register()/unregister().
  registerDatagramHandler(trackAlias, handler) {
    this.register(trackAlias, handler);
  }
  unregisterDatagramHandler(trackAlias) {
    this.unregister(trackAlias);
  }
  /** Number of buffered pre-handler datagrams (tests/diagnostics). */
  pendingCount() {
    return this.pending.length;
  }
  /** Drop all handlers + buffered datagrams (connection close). */
  clear() {
    this.handlers.clear();
    this.pending = [];
    this.pendingBytes = 0;
  }
  drainForAlias(trackAlias, handler) {
    const remaining = [];
    let drainedBytes = 0;
    for (const d of this.pending) {
      if (d.trackAlias === trackAlias) {
        try {
          handler(d.payload, d.trackAlias, d.groupId, d.objectId);
        } catch {
        }
        drainedBytes += d.payload.length;
      } else {
        remaining.push(d);
      }
    }
    this.pending = remaining;
    this.pendingBytes -= drainedBytes;
  }
  discardForAlias(trackAlias) {
    const remaining = [];
    let discardedBytes = 0;
    for (const d of this.pending) {
      if (d.trackAlias === trackAlias) {
        discardedBytes += d.payload.length;
      } else {
        remaining.push(d);
      }
    }
    this.pending = remaining;
    this.pendingBytes -= discardedBytes;
  }
  bufferUnknown(d) {
    this.pending.push(d);
    this.pendingBytes += d.payload.length;
    while (this.pendingBytes > PENDING_DATAGRAM_MAX_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped.payload.length;
    }
  }
}
new TextEncoder();
function entityNamespace(space, entityId, direction) {
  return [space, "entity", entityId, direction];
}
function clientNamespace(space, clientId, direction) {
  return [space, "client", clientId, direction];
}
function presenceNamespace(space) {
  return [space, "presence"];
}
const TRACK_MONO_OBJECT = "mono-object";
const TRACK_BINAURAL = "binaural";
const TRACK_AMBI2 = "ambi2";
const TRACK_AMBI3 = "ambi3";
const TRACK_STATE = "state";
const TRACK_PRESENCE = "presence";
class MalformedError extends Error {
}
class UnknownFlagsError extends Error {
}
const FLAG_POSE = 1 << 0;
const FLAG_AUDIO = 1 << 1;
const FLAG_REDUNDANCY = 1 << 2;
const OFFSET_SHIFT = 3;
const OFFSET_BITS = 7 << OFFSET_SHIFT;
const FLAG_TS = 1 << 6;
const FLAG_RESERVED = 1 << 7;
const POSE_SIZE = 18;
const ANGLE_QUANTUM = Math.PI / 32767;
function parsePose(view, offset) {
  if (view.byteLength - offset < POSE_SIZE) {
    throw new MalformedError("truncated pose");
  }
  return {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true),
    yaw: view.getInt16(offset + 12, true) * ANGLE_QUANTUM,
    pitch: view.getInt16(offset + 14, true) * ANGLE_QUANTUM,
    roll: view.getInt16(offset + 16, true) * ANGLE_QUANTUM
  };
}
function parseSink(data) {
  if (data.length === 0) throw new MalformedError("empty packet");
  const flags = data[0];
  if ((flags & (FLAG_POSE | FLAG_AUDIO | FLAG_RESERVED)) !== 0) throw new UnknownFlagsError("sink");
  if ((flags & FLAG_REDUNDANCY) === 0 && (flags & OFFSET_BITS) !== 0) {
    throw new UnknownFlagsError("sink offset bits");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 1;
  let ts;
  if ((flags & FLAG_TS) !== 0) {
    if (data.length - o < 8) throw new MalformedError("truncated timestamp");
    ts = view.getBigUint64(o, true);
    o += 8;
  }
  if ((flags & FLAG_REDUNDANCY) !== 0) {
    if (data.length - o < 2) throw new MalformedError("truncated audio length");
    const alen = view.getUint16(o, true);
    o += 2;
    if (data.length - o < alen) throw new MalformedError("truncated audio");
    const audio2 = data.subarray(o, o + alen);
    if (audio2.length === 0) throw new MalformedError("sink packets always carry audio");
    o += alen;
    const red = data.subarray(o);
    if (red.length === 0) throw new MalformedError("empty redundancy payload");
    return {
      timestampMicros: ts,
      audio: audio2,
      redundancy: { offset: (flags & OFFSET_BITS) >> OFFSET_SHIFT, audio: red }
    };
  }
  const audio = data.subarray(o);
  if (audio.length === 0) throw new MalformedError("sink packets always carry audio");
  return { timestampMicros: ts, audio };
}
const LOUDNESS_SILENT = 255;
function loudnessToDBFS(l) {
  return l === LOUDNESS_SILENT ? -Infinity : l * -0.5;
}
const PRESENCE_FLAG_KEYFRAME = 1 << 0;
const KRECORD_FLAG_HEAD_FRAME = 1 << 0;
const textDecoder$2 = new TextDecoder();
const VALID_IDENTIFIER_RE = /^[a-z0-9-]{1,128}$/;
function parsePresence(data) {
  if (data.length < 2) throw new MalformedError("truncated presence packet");
  const flags = data[0];
  if ((flags & ~PRESENCE_FLAG_KEYFRAME) !== 0) throw new UnknownFlagsError("presence");
  const gen = data[1];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if ((flags & PRESENCE_FLAG_KEYFRAME) !== 0) {
    if (data.length < 4) throw new MalformedError("truncated keyframe header");
    const first = view.getUint16(2, true);
    let o2 = 4;
    const records2 = [];
    while (o2 < data.length) {
      if (data.length - o2 < 2) throw new MalformedError("truncated krecord header");
      const kflags = data[o2];
      if ((kflags & ~KRECORD_FLAG_HEAD_FRAME) !== 0) throw new UnknownFlagsError("krecord");
      const idLen = data[o2 + 1];
      o2 += 2;
      if (data.length - o2 < idLen + POSE_SIZE + 1) throw new MalformedError("truncated krecord");
      const id = textDecoder$2.decode(data.subarray(o2, o2 + idLen));
      if (!VALID_IDENTIFIER_RE.test(id)) throw new MalformedError("invalid krecord id");
      o2 += idLen;
      const pose = parsePose(view, o2);
      o2 += POSE_SIZE;
      const loudness = data[o2];
      o2 += 1;
      records2.push({ headFrame: (kflags & KRECORD_FLAG_HEAD_FRAME) !== 0, id, pose, loudness });
    }
    return { kind: "keyframe", gen, first, records: records2 };
  }
  let o = 2;
  const records = [];
  while (o < data.length) {
    if (data.length - o < 2 + POSE_SIZE + 1) throw new MalformedError("truncated delta record");
    const index = view.getUint16(o, true);
    o += 2;
    const pose = parsePose(view, o);
    o += POSE_SIZE;
    const loudness = data[o];
    o += 1;
    records.push({ index, pose, loudness });
  }
  return { kind: "delta", gen, records };
}
const SUBSCRIBE_PARAM_STATE = 107939;
const EPOCH_SIZE = 8;
const MAX_VALUE_LEN = 65536;
const MAX_KEY_LEN = 512;
const VALID_KEY_RE = /^[a-z0-9.-]{1,512}$/;
const VALID_PREFIX_RE = /^[a-z0-9.-]{0,512}$/;
const MSG_SET = 1;
const MSG_CLEAR = 2;
const MSG_GROUP = 3;
const MSG_FRONTIER = 4;
const MSG_BEGIN = 5;
const BEGIN_DELTA = 1;
const BEGIN_SNAPSHOT = 2;
const textEncoder$1 = new TextEncoder();
const textDecoder$1 = new TextDecoder();
function appendVarint(parts, v) {
  const n = BigInt(v);
  if (n < 64n) {
    parts.push(Number(n));
  } else if (n < 16384n) {
    parts.push(Number(n >> 8n) | 64, Number(n & 0xffn));
  } else if (n < 1073741824n) {
    parts.push(Number(n >> 24n) | 128, Number(n >> 16n & 0xffn), Number(n >> 8n & 0xffn), Number(n & 0xffn));
  } else {
    parts.push(Number(n >> 56n) | 192);
    for (let s = 48n; s >= 0n; s -= 8n) parts.push(Number(n >> s & 0xffn));
  }
}
function readVarint(data, o) {
  if (o >= data.length) throw new MalformedError("truncated varint");
  const width = 1 << (data[o] >> 6);
  if (o + width > data.length) throw new MalformedError("truncated varint");
  let v = BigInt(data[o] & 63);
  for (let i = 1; i < width; i++) v = v << 8n | BigInt(data[o + i]);
  return { value: v, next: o + width };
}
function encodeStateMessage(m, dir) {
  const parts = [];
  appendStateMessage(parts, m, dir, true);
  return new Uint8Array(parts);
}
function appendSeq(parts, seq, dir) {
  return;
}
function appendStateMessage(parts, m, dir, allowGroup) {
  switch (m.kind) {
    case "set": {
      if (!VALID_KEY_RE.test(m.key)) throw new MalformedError("invalid key");
      if (m.value.length > MAX_VALUE_LEN) throw new MalformedError("value too long");
      parts.push(MSG_SET);
      const key = textEncoder$1.encode(m.key);
      appendVarint(parts, key.length);
      for (const b of key) parts.push(b);
      appendVarint(parts, m.value.length);
      for (const b of m.value) parts.push(b);
      appendSeq(parts, m.seq);
      return;
    }
    case "clear": {
      if (!VALID_KEY_RE.test(m.key)) throw new MalformedError("invalid key");
      parts.push(MSG_CLEAR);
      const key = textEncoder$1.encode(m.key);
      appendVarint(parts, key.length);
      for (const b of key) parts.push(b);
      appendSeq(parts, m.seq);
      return;
    }
    case "group": {
      if (!allowGroup) throw new MalformedError("groups do not nest");
      parts.push(MSG_GROUP);
      appendVarint(parts, m.ops.length);
      for (const op of m.ops) appendStateMessage(parts, op, dir, false);
      return;
    }
    case "frontier": {
      throw new MalformedError("frontier is downstream-only");
    }
    case "begin": {
      throw new MalformedError("begin is downstream-only");
    }
  }
}
function parseStateMessage(data, dir) {
  const { msg, next } = parseOne(data, 0, dir, true);
  if (next !== data.length) throw new MalformedError("trailing bytes after state message");
  return msg;
}
function readKey(data, o) {
  const r = readVarint(data, o);
  const klen = Number(r.value);
  if (klen > MAX_KEY_LEN) throw new MalformedError("key too long");
  o = r.next;
  if (o + klen > data.length) throw new MalformedError("truncated key");
  const key = textDecoder$1.decode(data.subarray(o, o + klen));
  if (!VALID_KEY_RE.test(key)) throw new MalformedError("invalid key");
  return { key, next: o + klen };
}
function parseOne(data, o, dir, allowGroup) {
  if (o >= data.length) throw new MalformedError("empty state message");
  const t = data[o];
  o += 1;
  switch (t) {
    case MSG_SET: {
      const k = readKey(data, o);
      const key = k.key;
      o = k.next;
      let r = readVarint(data, o);
      const vlen = Number(r.value);
      o = r.next;
      if (vlen > MAX_VALUE_LEN) throw new MalformedError("value too long");
      if (o + vlen > data.length) throw new MalformedError("truncated value");
      const value = data.slice(o, o + vlen);
      o += vlen;
      let seq = 0n;
      {
        r = readVarint(data, o);
        seq = r.value;
        o = r.next;
      }
      return { msg: { kind: "set", key, value, seq }, next: o };
    }
    case MSG_CLEAR: {
      const k = readKey(data, o);
      const key = k.key;
      o = k.next;
      let seq = 0n;
      {
        const r = readVarint(data, o);
        seq = r.value;
        o = r.next;
      }
      return { msg: { kind: "clear", key, seq }, next: o };
    }
    case MSG_GROUP: {
      if (!allowGroup) throw new MalformedError("groups do not nest");
      const r = readVarint(data, o);
      o = r.next;
      const ops = [];
      for (let i = 0n; i < r.value; i++) {
        const inner = parseOne(data, o, dir, false);
        if (inner.msg.kind !== "set" && inner.msg.kind !== "clear") {
          throw new MalformedError("groups may contain only set and clear ops");
        }
        ops.push(inner.msg);
        o = inner.next;
      }
      return { msg: { kind: "group", ops }, next: o };
    }
    case MSG_FRONTIER: {
      if (o + EPOCH_SIZE > data.length) throw new MalformedError("truncated epoch");
      const epoch = data.slice(o, o + EPOCH_SIZE);
      o += EPOCH_SIZE;
      const r = readVarint(data, o);
      return { msg: { kind: "frontier", epoch, seq: r.value }, next: r.next };
    }
    case MSG_BEGIN: {
      if (o >= data.length) throw new MalformedError("truncated begin");
      const kind = data[o];
      if (kind !== BEGIN_DELTA && kind !== BEGIN_SNAPSHOT) throw new MalformedError("unknown begin kind");
      return { msg: { kind: "begin", begin: kind === BEGIN_DELTA ? "delta" : "snapshot" }, next: o + 1 };
    }
    default:
      throw new MalformedError(`unknown state message type ${t}`);
  }
}
function canonicalPrefixes(prefixes) {
  for (const p of prefixes) {
    if (!VALID_PREFIX_RE.test(p)) throw new MalformedError(`invalid prefix ${JSON.stringify(p)}`);
  }
  return [...new Set(prefixes)].sort();
}
const SUBSCRIBE_FLAG_CURSOR = 1 << 0;
function encodeSubscribeParams(prefixes, cursor) {
  const canon = canonicalPrefixes(prefixes);
  if (canon.length === 0) throw new MalformedError("empty prefix set is a protocol error");
  const parts = [];
  parts.push(cursor ? SUBSCRIBE_FLAG_CURSOR : 0);
  appendVarint(parts, canon.length);
  for (const p of canon) {
    const b = textEncoder$1.encode(p);
    appendVarint(parts, b.length);
    for (const x of b) parts.push(x);
  }
  if (cursor) {
    for (const b of cursor.epoch) parts.push(b);
    appendVarint(parts, cursor.seq);
    for (const b of cursor.setHash) parts.push(b);
  }
  return new Uint8Array(parts);
}
async function setHash(prefixes) {
  const parts = [];
  for (const p of canonicalPrefixes(prefixes)) {
    const b = textEncoder$1.encode(p);
    appendVarint(parts, b.length);
    for (const x of b) parts.push(x);
  }
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(parts));
  return new Uint8Array(digest);
}
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function encodeValue(v) {
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new MalformedError(`base value must be finite, got ${v}`);
  }
  return textEncoder.encode(JSON.stringify(v));
}
function decodeValue(bytes) {
  if (!bytes) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    return void 0;
  }
  switch (typeof parsed) {
    case "boolean":
    case "string":
      return parsed;
    case "number":
      return Number.isFinite(parsed) ? parsed : void 0;
    default:
      return void 0;
  }
}
const IDENTIFIER_RE = /^[a-z0-9-]{1,128}$/;
const ATTR_PATH_RE = /^[a-z0-9-]{1,128}(\.[a-z0-9-]{1,128})*$/;
function isIdentifier(s) {
  return IDENTIFIER_RE.test(s);
}
function ident(s, what) {
  if (!IDENTIFIER_RE.test(s)) throw new MalformedError(`invalid ${what} ${JSON.stringify(s)}: must match [a-z0-9-]{1,128}`);
  return s;
}
function attrPath(s) {
  if (!ATTR_PATH_RE.test(s)) {
    throw new MalformedError(`invalid attr path ${JSON.stringify(s)}: dotted identifiers only`);
  }
  return s;
}
const BASE_PREFIX = "lasa.";
const keys = {
  /** `lasa.entity.{id}` — the existence marker, valued with the owning client id. */
  entityMarker: (id) => `lasa.entity.${ident(id, "entity id")}`,
  /** `lasa.entity.{id}.{suffix}`. The suffix is not validated; prefer a specific builder. */
  entity: (id, suffix) => `lasa.entity.${ident(id, "entity id")}.${suffix}`,
  name: (id) => keys.entity(id, "name"),
  attr: (id, path) => keys.entity(id, `attrs.${attrPath(path)}`),
  signedAttr: (id, path) => keys.entity(id, `signed-attrs.${attrPath(path)}`),
  heardIn: (id, channel) => keys.entity(id, `heard-in.${ident(channel, "channel")}`),
  hears: (id, channel) => keys.entity(id, `hears.${ident(channel, "channel")}`),
  priority: (id) => keys.entity(id, "priority"),
  renderGain: (id) => keys.entity(id, "render.gain"),
  renderAttenuation: (id) => keys.entity(id, "render.attenuation"),
  renderSize: (id) => keys.entity(id, "render.size"),
  renderDirectivity: (id) => keys.entity(id, "render.directivity"),
  frame: (id) => keys.entity(id, "frame"),
  dof: (id) => keys.entity(id, "dof"),
  personalMute: (owner, other) => keys.entity(owner, `mute.${ident(other, "entity id")}`),
  personalSolo: (owner, other) => keys.entity(owner, `solo.${ident(other, "entity id")}`),
  spaceEntityMuted: (id) => `lasa.space.entity.muted.${ident(id, "entity id")}`,
  clientBlocked: (id) => `lasa.space.client.blocked.${ident(id, "client id")}`,
  roleBlocked: (role) => `lasa.space.role.blocked.${ident(role, "role")}`,
  channelMuted: (ch) => `lasa.space.channel.muted.${ident(ch, "channel")}`,
  channelGain: (ch) => `lasa.space.channel.gain.${ident(ch, "channel")}`,
  channelAttenuation: (ch) => `lasa.space.channel.attenuation.${ident(ch, "channel")}`
};
function set(key, value) {
  return { kind: "set", key, value: encodeValue(value) };
}
function clear(key) {
  return { kind: "clear", key };
}
function oneOrGroup(ops) {
  if (ops.length === 0) return [];
  if (ops.length === 1) return [ops[0]];
  return [{ kind: "group", ops }];
}
function range(name, v, lo, hi) {
  if (!Number.isFinite(v) || v < lo || v > hi) {
    throw new MalformedError(`${name} must be in ${lo}–${hi}, got ${v}`);
  }
  return v;
}
function blockedValue(until) {
  if (until === void 0) return 0;
  const secs = Math.floor(until.getTime() / 1e3);
  if (!Number.isFinite(secs) || secs <= 0) throw new MalformedError(`invalid block expiry ${until}`);
  return secs;
}
class EntityControls {
  constructor(writer, entityId) {
    this.writer = writer;
    this.entityId = entityId;
    ident(entityId, "entity id");
  }
  /** Silences the pair (this entity, `other`) in both directions. */
  mute(other) {
    return this.writer.writeState(set(keys.personalMute(this.entityId, other), true));
  }
  unmute(other) {
    return this.writer.writeState(clear(keys.personalMute(this.entityId, other)));
  }
  /** Hear `other` and the other solo'd entities only, overriding mutes. */
  solo(other) {
    return this.writer.writeState(set(keys.personalSolo(this.entityId, other), true));
  }
  unsolo(other) {
    return this.writer.writeState(clear(keys.personalSolo(this.entityId, other)));
  }
  /** Sets one runtime attribute, `path` dotted per §1 (`colour`, `avatar.hat`). */
  setAttr(path, value) {
    return this.writer.writeState(set(keys.attr(this.entityId, path), value));
  }
  clearAttr(path) {
    return this.writer.writeState(clear(keys.attr(this.entityId, path)));
  }
  /** Sets several attributes as one group (flat: one entry per leaf path). */
  setAttrs(attrs) {
    return this.writer.writeState(
      ...oneOrGroup(Object.entries(attrs).map(([p, v]) => set(keys.attr(this.entityId, p), v)))
    );
  }
}
class SpaceControls {
  constructor(writer) {
    this.writer = writer;
  }
  // --- moderation (§5) ---
  /** Silences the entity's source in every render. Rendering only; the connection stays. */
  muteEntity(entityId) {
    return this.writer.writeState(set(keys.spaceEntityMuted(entityId), true));
  }
  unmuteEntity(entityId) {
    return this.writer.writeState(clear(keys.spaceEntityMuted(entityId)));
  }
  /**
   * Terminates the client's live connection and refuses readmission
   * until `until` (forever when omitted). Admin is unblockable.
   */
  blockClient(clientId, until) {
    return this.writer.writeState(set(keys.clientBlocked(clientId), blockedValue(until)));
  }
  unblockClient(clientId) {
    return this.writer.writeState(clear(keys.clientBlocked(clientId)));
  }
  /** A block with a short expiry — "a kick is a block with a short expiry" (§5). */
  kickClient(clientId, forMs) {
    if (!(forMs > 0)) throw new MalformedError(`kick duration must be positive, got ${forMs}`);
    return this.blockClient(clientId, new Date(Date.now() + forMs));
  }
  /** Blocks every connection bearing the role (except admin). */
  blockRole(role, until) {
    return this.writer.writeState(set(keys.roleBlocked(role), blockedValue(until)));
  }
  unblockRole(role) {
    return this.writer.writeState(clear(keys.roleBlocked(role)));
  }
  // --- hearing: channel policy (§4) ---
  /** A muted channel contributes nothing to audibility. */
  muteChannel(channel) {
    return this.writer.writeState(set(keys.channelMuted(channel), true));
  }
  unmuteChannel(channel) {
    return this.writer.writeState(clear(keys.channelMuted(channel)));
  }
  /** Channel gain 0–3.0 (amplitude); the highest across a pair's shared channels wins. `undefined` clears. */
  setChannelGain(channel, gain) {
    const key = keys.channelGain(channel);
    return this.writer.writeState(gain === void 0 ? clear(key) : set(key, range("channel gain", gain, 0, 3)));
  }
  /** Channel attenuation 0–3.0; the lowest set value across a pair's shared channels overrides the source's. `undefined` clears. */
  setChannelAttenuation(channel, attenuation) {
    const key = keys.channelAttenuation(channel);
    return this.writer.writeState(
      attenuation === void 0 ? clear(key) : set(key, range("channel attenuation", attenuation, 0, 3))
    );
  }
  // --- hearing: entity membership and rendering (§4, §6) ---
  /** Adds the entity's source to a channel (it is heard there). */
  addHeardIn(entityId, channel) {
    return this.writer.writeState(set(keys.heardIn(entityId, channel), true));
  }
  removeHeardIn(entityId, channel) {
    return this.writer.writeState(clear(keys.heardIn(entityId, channel)));
  }
  /** Adds the entity's sink to a channel (it hears there). */
  addHears(entityId, channel) {
    return this.writer.writeState(set(keys.hears(entityId, channel), true));
  }
  removeHears(entityId, channel) {
    return this.writer.writeState(clear(keys.hears(entityId, channel)));
  }
  /**
   * Replaces the entity's memberships as one group: `current` is what
   * the store holds now (see {@link BaseView.entity}), `next` the wanted
   * sets. Omitted sides are left alone. Emptying `heardIn` leaves the
   * entity inaudible (§6) — a moderation act, so it is allowed.
   */
  setChannels(entityId, current, next) {
    const ops = [];
    const diff = (have, want, key) => {
      if (!want) return;
      const wantSet = new Set(want);
      for (const ch of have) if (!wantSet.has(ch)) ops.push(clear(key(ch)));
      for (const ch of want) if (!have.includes(ch)) ops.push(set(key(ch), true));
    };
    diff(current.heardIn, next.heardIn, (ch) => keys.heardIn(entityId, ch));
    diff(current.hears, next.hears, (ch) => keys.hears(entityId, ch));
    return this.writer.writeState(...oneOrGroup(ops));
  }
  /** Sets the given render parameters as one group; `undefined` fields are untouched, `null` clears to the default. */
  setRender(entityId, params) {
    const ops = [];
    const field = (v, key, name, lo, hi) => {
      if (v === void 0) return;
      ops.push(v === null ? clear(key) : set(key, range(name, v, lo, hi)));
    };
    field(params.gain, keys.renderGain(entityId), "gain", 0, 3);
    field(params.attenuation, keys.renderAttenuation(entityId), "attenuation", 0, 3);
    field(params.size, keys.renderSize(entityId), "size", 0, Infinity);
    field(params.directivity, keys.renderDirectivity(entityId), "directivity", 0, 1);
    return this.writer.writeState(...oneOrGroup(ops));
  }
  /** Marks the entity's source as important to render well — sparingly (§6). */
  setPriority(entityId, priority) {
    const key = keys.priority(entityId);
    return this.writer.writeState(priority ? set(key, true) : clear(key));
  }
  /** Degrees of freedom the space enforces at ingest: 6 free, 3 turn in place, 0 fixed (`moderator`). */
  setDof(entityId, dof) {
    if (dof !== 0 && dof !== 3 && dof !== 6) throw new MalformedError(`dof must be 0, 3 or 6, got ${dof}`);
    return this.writer.writeState(dof === 6 ? clear(keys.dof(entityId)) : set(keys.dof(entityId), dof));
  }
}
const ENTITY_RE = /^lasa\.entity\.([a-z0-9-]{1,128})(?:\.(.+))?$/;
class BaseView {
  constructor(store) {
    this.store = store;
  }
  /** Every live entity (marker present), in key order. */
  entities() {
    const views = /* @__PURE__ */ new Map();
    for (const [key, kv] of this.store) {
      const m = ENTITY_RE.exec(key);
      if (!m || m[2] !== void 0) continue;
      const owner = decodeValue(kv.value);
      if (typeof owner !== "string") continue;
      views.set(m[1], emptyView(m[1], owner));
    }
    for (const [key, kv] of this.store) {
      const m = ENTITY_RE.exec(key);
      if (!m || m[2] === void 0) continue;
      const v = views.get(m[1]);
      if (v) applyEntityKey(v, m[2], decodeValue(kv.value));
    }
    return [...views.keys()].sort().map((id) => views.get(id));
  }
  /** One entity, or undefined if its marker is absent. */
  entity(id) {
    const owner = decodeValue(this.store.get(keys.entityMarker(id)));
    if (typeof owner !== "string") return void 0;
    const v = emptyView(id, owner);
    const prefix = `lasa.entity.${id}.`;
    for (const [key, kv] of this.store) {
      if (key.startsWith(prefix)) applyEntityKey(v, key.slice(prefix.length), decodeValue(kv.value));
    }
    return v;
  }
  /** Whether the space has muted the entity's source (§5). */
  isEntityMuted(entityId) {
    return decodeValue(this.store.get(keys.spaceEntityMuted(entityId))) === true;
  }
  /** The client's block, or undefined when not blocked. Expiry is not evaluated here — the server's clock decides. */
  clientBlock(clientId) {
    return blockView(clientId, decodeValue(this.store.get(keys.clientBlocked(clientId))));
  }
  roleBlock(role) {
    return blockView(role, decodeValue(this.store.get(keys.roleBlocked(role))));
  }
  /** Every blocked client. */
  blockedClients() {
    return this.collectBlocks("lasa.space.client.blocked.");
  }
  blockedRoles() {
    return this.collectBlocks("lasa.space.role.blocked.");
  }
  /** Channel policy: muted flag and any set gain/attenuation override. */
  channel(channel) {
    const gain = decodeValue(this.store.get(keys.channelGain(channel)));
    const att = decodeValue(this.store.get(keys.channelAttenuation(channel)));
    return {
      muted: decodeValue(this.store.get(keys.channelMuted(channel))) === true,
      ...typeof gain === "number" ? { gain } : {},
      ...typeof att === "number" ? { attenuation: att } : {}
    };
  }
  /** Every channel named by a live entity's membership or by channel policy, sorted. */
  channels() {
    const out = /* @__PURE__ */ new Set();
    for (const e of this.entities()) {
      for (const ch of e.heardIn) out.add(ch);
      for (const ch of e.hears) out.add(ch);
    }
    for (const [key] of this.store) {
      const m = /^lasa\.space\.channel\.(?:muted|gain|attenuation)\.([a-z0-9-]{1,128})$/.exec(key);
      if (m) out.add(m[1]);
    }
    return [...out].sort();
  }
  collectBlocks(prefix) {
    const out = [];
    for (const [key, kv] of this.store) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!isIdentifier(id)) continue;
      const b = blockView(id, decodeValue(kv.value));
      if (b) out.push(b);
    }
    return out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
}
function baseView(store) {
  return new BaseView(store);
}
function emptyView(id, owner) {
  return {
    id,
    owner,
    name: "",
    attrs: {},
    signedAttrs: {},
    heardIn: [],
    hears: [],
    priority: false,
    render: {},
    frame: "world",
    dof: 6,
    mutes: [],
    solos: []
  };
}
function blockView(id, v) {
  if (typeof v !== "number" || v < 0) return void 0;
  return { id, until: v === 0 ? null : new Date(v * 1e3) };
}
function applyEntityKey(v, suffix, value) {
  if (value === void 0) return;
  const dot = suffix.indexOf(".");
  const head = dot < 0 ? suffix : suffix.slice(0, dot);
  const rest = dot < 0 ? "" : suffix.slice(dot + 1);
  switch (head) {
    case "name":
      if (typeof value === "string") v.name = value;
      break;
    case "attrs":
      if (rest) v.attrs[rest] = value;
      break;
    case "signed-attrs":
      if (rest) v.signedAttrs[rest] = value;
      break;
    case "heard-in":
      if (rest && value === true) v.heardIn.push(rest);
      break;
    case "hears":
      if (rest && value === true) v.hears.push(rest);
      break;
    case "priority":
      v.priority = value === true;
      break;
    case "render": {
      if (typeof value !== "number") break;
      if (rest === "gain") v.render.gain = value;
      else if (rest === "attenuation") v.render.attenuation = value;
      else if (rest === "size") v.render.size = value;
      else if (rest === "directivity") v.render.directivity = value;
      break;
    }
    case "frame":
      if (value === "head" || value === "world") v.frame = value;
      break;
    case "dof":
      if (value === 0 || value === 3 || value === 6) v.dof = value;
      break;
    case "mute":
      if (rest && value === true) v.mutes.push(rest);
      break;
    case "solo":
      if (rest && value === true) v.solos.push(rest);
      break;
  }
}
const CATCH_UP_LANE = 1n;
class StateSync {
  /** @internal Built by LasaClient. */
  constructor(session, router, spaceId, clientId, store, opts = {}) {
    this.session = session;
    this.router = router;
    this.spaceId = spaceId;
    this.clientId = clientId;
    this.store = store;
    this.opts = opts;
  }
  stopped = false;
  currentAlias = null;
  wakeup = null;
  endInstance = null;
  // Serializes store application: lane handlers are synchronous
  // callbacks but the store's apply methods are async.
  chain = Promise.resolve();
  log(...args) {
    if (this.opts.debug) console.log("[state]", ...args);
  }
  /** Starts the subscribe/apply/re-subscribe loop; resolves on stop(). */
  async run() {
    let backoff = this.opts.initialBackoffMs ?? 100;
    while (!this.stopped) {
      try {
        await this.syncOnce();
        backoff = this.opts.initialBackoffMs ?? 100;
      } catch (e) {
        this.log("sync error:", e);
      }
      if (this.stopped) return;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoff);
        this.wakeup = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wakeup = null;
      if (backoff < 5e3) backoff *= 2;
    }
  }
  /** Ends the loop: unregisters the lane, ends the current instance, and wakes any backoff wait. */
  stop() {
    this.stopped = true;
    if (this.currentAlias !== null) {
      this.router.unregister(this.currentAlias);
      this.currentAlias = null;
    }
    this.endInstance?.();
    this.wakeup?.();
  }
  /** Resolves after every message applied so far has been processed. */
  async settled() {
    await this.chain;
  }
  async syncOnce() {
    const { prefixes, cursor } = this.store.subscribeParams();
    const raw = encodeSubscribeParams(prefixes, cursor);
    const subId = await this.session.subscribe(
      clientNamespace(this.spaceId, this.clientId, "sink"),
      TRACK_STATE,
      void 0,
      void 0,
      [{ type: SUBSCRIBE_PARAM_STATE, value: raw }]
    );
    if (this.stopped) {
      return;
    }
    const alias = this.session.getTrackAlias(subId);
    if (alias === void 0) throw new Error("no track alias after SUBSCRIBE_OK");
    this.log(`subscribed, id=${subId} alias=${alias}`);
    const done = new Promise((resolve) => {
      this.endInstance = resolve;
      this.session.onPublishDone(subId, (status) => {
        this.log(`instance ended, status=${status}`);
        resolve();
      });
    });
    this.currentAlias = alias;
    this.router.register(alias, (h, o) => this.onObject(h, o));
    try {
      await done;
    } finally {
      this.router.unregister(alias);
      this.currentAlias = null;
      this.endInstance = null;
      this.session.removePublishDoneHandler(subId);
      await this.chain;
      await this.applySerialized(async () => this.store.terminated());
    }
  }
  onObject(h, o) {
    if (o.payload.length === 0) return;
    this.applySerialized(async () => {
      const msg = parseStateMessage(o.payload, "downstream");
      if (h.subgroupId === CATCH_UP_LANE) {
        await this.store.applyCatchUp(msg);
      } else {
        await this.store.applyLive(msg);
      }
    });
  }
  applySerialized(fn) {
    this.chain = this.chain.then(fn).catch((e) => this.log("apply error:", e));
    return this.chain;
  }
}
class PresenceRoster {
  gen = 0;
  seen = false;
  // a keyframe has established a generation
  slots = /* @__PURE__ */ new Map();
  /** Called after any packet that changed the roster. */
  onUpdate;
  /** Applies one presence packet under the §7 rules. */
  apply(groupId, msg) {
    let changed = false;
    if (msg.kind === "keyframe") {
      if (!this.seen || msg.gen !== this.gen) {
        this.seen = true;
        this.gen = msg.gen;
        this.slots.clear();
        changed = true;
      }
      for (let i = 0; i < msg.records.length; i++) {
        const rec = msg.records[i];
        const idx = msg.first + i;
        const slot = this.slots.get(idx);
        if (!slot) {
          this.slots.set(idx, {
            entry: { id: rec.id, headFrame: rec.headFrame, pose: rec.pose, loudness: rec.loudness },
            lastGroup: groupId
          });
          changed = true;
        } else if (groupId > slot.lastGroup) {
          slot.entry.pose = rec.pose;
          slot.entry.loudness = rec.loudness;
          slot.lastGroup = groupId;
          changed = true;
        }
      }
    } else {
      if (!this.seen || msg.gen !== this.gen) return;
      for (const rec of msg.records) {
        const slot = this.slots.get(rec.index);
        if (!slot) continue;
        if (groupId > slot.lastGroup) {
          slot.entry.pose = rec.pose;
          slot.entry.loudness = rec.loudness;
          slot.lastGroup = groupId;
          changed = true;
        }
      }
    }
    if (changed) this.onUpdate?.();
  }
  /** The current roster, in unspecified order (entries are copies). */
  snapshot() {
    return [...this.slots.values()].map((s) => ({ ...s.entry }));
  }
}
const LASA_ERR = {
  /** Malformed / schema-invalid Connection Config. */
  MALFORMED_CONFIG: 1726976,
  /** Invalid ticket (signature, expired, not yet valid, wrong audience) — or no ticket presented to a ticketed space. */
  INVALID_TICKET: 1726977,
  /** client_id does not match the ticket claim. */
  CLIENT_ID_MISMATCH: 1726978,
  /** RETIRED 2026-08-13 (unticketed collisions now supersede); never reused. */
  ID_COLLISION_RETIRED: 1726979,
  /** Entity id collides with another client's live entity (ticketed). */
  ENTITY_COLLISION: 1726980,
  /** Ad-hoc entities not permitted for this ticket. */
  AD_HOC_NOT_PERMITTED: 1726981,
  /** Blocked (reason string SHOULD carry the block expiry timestamp). */
  BLOCKED: 1726982,
  /** Space at capacity. */
  AT_CAPACITY: 1726983,
  /** Ticket presented to an unticketed space (mode mismatch). */
  MODE_MISMATCH: 1726984,
  /** The space is shutting down deliberately; reconnecting later is reasonable. */
  SHUTTING_DOWN: 1726985,
  /** Superseded by a newer connection exercising the same client id (§4.4). */
  SUPERSEDED: 1726986
};
const NAMES = {
  [LASA_ERR.MALFORMED_CONFIG]: "malformed connection config",
  [LASA_ERR.INVALID_TICKET]: "invalid or missing ticket",
  [LASA_ERR.CLIENT_ID_MISMATCH]: "client_id does not match the ticket claim",
  [LASA_ERR.ID_COLLISION_RETIRED]: "id collision (retired code)",
  [LASA_ERR.ENTITY_COLLISION]: "entity id collides with another client's live entity",
  [LASA_ERR.AD_HOC_NOT_PERMITTED]: "ad-hoc entities not permitted for this ticket",
  [LASA_ERR.BLOCKED]: "blocked",
  [LASA_ERR.AT_CAPACITY]: "space at capacity",
  [LASA_ERR.MODE_MISMATCH]: "ticket presented to an unticketed space",
  [LASA_ERR.SHUTTING_DOWN]: "space shutting down",
  [LASA_ERR.SUPERSEDED]: "superseded by a newer connection"
};
function isLasaRejectionCode(code) {
  return code >= LASA_ERR.MALFORMED_CONFIG && code <= LASA_ERR.SUPERSEDED && code !== LASA_ERR.ID_COLLISION_RETIRED;
}
function lasaErrorName(code) {
  return NAMES[code] ?? null;
}
class LasaRejectionError extends Error {
  constructor(code, reason) {
    super(
      `LASA rejection 0x${code.toString(16)} (${lasaErrorName(code) ?? "unknown"})${reason ? `: ${reason}` : ""}`
    );
    this.code = code;
    this.reason = reason;
    this.name = "LasaRejectionError";
  }
}
class WorkerTransport {
  constructor(port) {
    this.port = port;
    port.onmessage = (e) => this.dispatch(e.data);
  }
  nextRequestId = 1;
  pending = /* @__PURE__ */ new Map();
  publishDoneHandlers = /* @__PURE__ */ new Map();
  events = {};
  /**
   * Wraps a real Worker. The worker itself comes from
   * `moq-worker-loader.ts` (`createMoqWorker()`), kept out of this
   * module so the RPC layer stays unit-testable without the bundle.
   */
  static spawn(worker) {
    return new WorkerTransport(worker);
  }
  setEvents(events) {
    this.events = { ...this.events, ...events };
  }
  /**
   * PUBLISH_DONE dispatch, keyed by subscribe id — the main-side mirror
   * of the session's one-shot handler table (the worker forwards every
   * instance end; only registered ids are delivered).
   */
  onPublishDone(subscribeId, handler) {
    this.publishDoneHandlers.set(subscribeId, handler);
  }
  removePublishDoneHandler(subscribeId) {
    this.publishDoneHandlers.delete(subscribeId);
  }
  dispatch(msg) {
    switch (msg.type) {
      case "connected":
      case "subscribed":
      case "stateWritten":
      case "sinkTrackSet":
      case "sinkTrackCleared":
      case "captureTrackSet":
      case "captureStopped":
      case "closed": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        break;
      }
      case "fail": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.closeCode !== void 0 && isLasaRejectionCode(msg.closeCode)) {
            p.reject(new LasaRejectionError(msg.closeCode, msg.closeReason ?? msg.message));
          } else {
            p.reject(new Error(msg.message));
          }
        }
        break;
      }
      case "publishDone": {
        const handler = this.publishDoneHandlers.get(msg.subscribeId);
        if (handler) {
          this.publishDoneHandlers.delete(msg.subscribeId);
          handler(msg.statusCode, msg.reason);
        }
        break;
      }
      case "incomingSubscribe":
        this.events.onIncomingSubscribe?.(msg);
        break;
      case "datagram":
        this.events.onDatagram?.(msg);
        break;
      case "subgroupObject":
        this.events.onSubgroupObject?.(msg);
        break;
      case "notice":
        this.events.onNotice?.(msg);
        break;
      case "decodedFormat":
        this.events.onDecodedFormat?.(msg);
        break;
      case "sinkIngress":
        this.events.onSinkIngress?.(msg);
        break;
      case "transportClosed":
        this.events.onTransportClosed?.(msg);
        break;
    }
  }
  request(build) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage(build(id));
    });
  }
  async connect(url, config, serverCertificateHashBase64, debug) {
    await this.request((id) => ({ type: "connect", id, url, config, serverCertificateHashBase64, debug }));
  }
  async subscribe(namespace, trackName, extraParams) {
    const reply = await this.request((id) => ({ type: "subscribe", id, namespace, trackName, extraParams }));
    if (reply.type !== "subscribed") throw new Error(`unexpected reply ${reply.type}`);
    return { subscribeId: reply.subscribeId, trackAlias: reply.trackAlias };
  }
  /**
   * Fire-and-forget datagram send. postMessage structured-clones the
   * bytes synchronously, so callers may reuse their scratch buffer
   * immediately (no transfer on purpose).
   */
  sendDatagram(bytes) {
    this.port.postMessage({ type: "sendDatagram", bytes });
  }
  /** Fire-and-forget: one mono-object packet on an entity's source track (the worker sequences it). */
  publish(entityId, packet) {
    this.port.postMessage({ type: "publish", entityId, packet });
  }
  async writeState(payloads) {
    await this.request((id) => ({ type: "writeState", id, payloads }));
  }
  /**
   * Divert a sink alias to in-worker decode into the shared jitter ring.
   * The SAB-backed views ride structured clone by reference.
   */
  async setSinkTrack(trackAlias, decoderConfig, jbufConfig, sharedStorage, sharedWritePos, redundancy = 0) {
    await this.request((id) => ({
      type: "setSinkTrack",
      id,
      trackAlias,
      decoderConfig,
      jbufConfig,
      sharedStorage,
      sharedWritePos,
      redundancy
    }));
  }
  async clearSinkTrack(trackAlias) {
    await this.request((id) => ({ type: "clearSinkTrack", id, trackAlias }));
  }
  /** Start the worker half of an entity's capture pipeline. */
  async setCaptureTrack(entityId, handoff, encoderConfig) {
    await this.request((id) => ({
      type: "setCaptureTrack",
      id,
      entityId,
      ...handoff,
      encoderConfig
    }));
  }
  async stopCapture(entityId) {
    await this.request((id) => ({ type: "stopCapture", id, entityId }));
  }
  async close() {
    try {
      await this.request((id) => ({ type: "close", id }));
    } finally {
      for (const p of this.pending.values()) p.reject(new Error("worker closed"));
      this.pending.clear();
      this.port.terminate?.();
    }
  }
}
class WorkerSessionProxy {
  constructor(transport) {
    this.transport = transport;
  }
  aliases = /* @__PURE__ */ new Map();
  async subscribe(namespace, trackName, _authorization, _resumeOpId, extraParams) {
    const { subscribeId, trackAlias } = await this.transport.subscribe(namespace, trackName, extraParams);
    this.aliases.set(subscribeId, trackAlias);
    return subscribeId;
  }
  getTrackAlias(subscribeId) {
    return this.aliases.get(subscribeId);
  }
  onPublishDone(subscribeId, handler) {
    this.transport.onPublishDone(subscribeId, handler);
  }
  removePublishDoneHandler(subscribeId) {
    this.transport.removePublishDoneHandler(subscribeId);
  }
}
const jsContent = 'var ConnectionState = /* @__PURE__ */ ((ConnectionState2) => {\n  ConnectionState2["DISCONNECTED"] = "disconnected";\n  ConnectionState2["CONNECTING"] = "connecting";\n  ConnectionState2["CONNECTED"] = "connected";\n  ConnectionState2["ERROR"] = "error";\n  return ConnectionState2;\n})(ConnectionState || {});\nvar MoqMessageType = /* @__PURE__ */ ((MoqMessageType2) => {\n  MoqMessageType2[MoqMessageType2["CLIENT_SETUP"] = 32] = "CLIENT_SETUP";\n  MoqMessageType2[MoqMessageType2["SERVER_SETUP"] = 33] = "SERVER_SETUP";\n  MoqMessageType2[MoqMessageType2["ANNOUNCE"] = 6] = "ANNOUNCE";\n  MoqMessageType2[MoqMessageType2["ANNOUNCE_OK"] = 7] = "ANNOUNCE_OK";\n  MoqMessageType2[MoqMessageType2["ANNOUNCE_ERROR"] = 8] = "ANNOUNCE_ERROR";\n  MoqMessageType2[MoqMessageType2["UNANNOUNCE"] = 9] = "UNANNOUNCE";\n  MoqMessageType2[MoqMessageType2["SUBSCRIBE"] = 3] = "SUBSCRIBE";\n  MoqMessageType2[MoqMessageType2["SUBSCRIBE_OK"] = 4] = "SUBSCRIBE_OK";\n  MoqMessageType2[MoqMessageType2["SUBSCRIBE_ERROR"] = 5] = "SUBSCRIBE_ERROR";\n  MoqMessageType2[MoqMessageType2["UNSUBSCRIBE"] = 10] = "UNSUBSCRIBE";\n  MoqMessageType2[MoqMessageType2["PUBLISH_DONE"] = 11] = "PUBLISH_DONE";\n  MoqMessageType2[MoqMessageType2["SUBSCRIBE_ANNOUNCES"] = 17] = "SUBSCRIBE_ANNOUNCES";\n  MoqMessageType2[MoqMessageType2["SUBSCRIBE_ANNOUNCES_OK"] = 18] = "SUBSCRIBE_ANNOUNCES_OK";\n  MoqMessageType2[MoqMessageType2["OBJECT_STREAM"] = 0] = "OBJECT_STREAM";\n  MoqMessageType2[MoqMessageType2["OBJECT_DATAGRAM"] = 1] = "OBJECT_DATAGRAM";\n  MoqMessageType2[MoqMessageType2["GOAWAY"] = 16] = "GOAWAY";\n  return MoqMessageType2;\n})(MoqMessageType || {});\nvar MoqSetupParameter = /* @__PURE__ */ ((MoqSetupParameter2) => {\n  MoqSetupParameter2[MoqSetupParameter2["ROLE"] = 0] = "ROLE";\n  MoqSetupParameter2[MoqSetupParameter2["PATH"] = 1] = "PATH";\n  MoqSetupParameter2[MoqSetupParameter2["MAX_SUBSCRIBE_ID"] = 2] = "MAX_SUBSCRIBE_ID";\n  return MoqSetupParameter2;\n})(MoqSetupParameter || {});\nvar MoqRole = /* @__PURE__ */ ((MoqRole2) => {\n  MoqRole2[MoqRole2["PUBLISHER"] = 0] = "PUBLISHER";\n  MoqRole2[MoqRole2["SUBSCRIBER"] = 1] = "SUBSCRIBER";\n  MoqRole2[MoqRole2["PUBSUB"] = 2] = "PUBSUB";\n  return MoqRole2;\n})(MoqRole || {});\nvar MoqFilterType = /* @__PURE__ */ ((MoqFilterType2) => {\n  MoqFilterType2[MoqFilterType2["LATEST_GROUP"] = 1] = "LATEST_GROUP";\n  MoqFilterType2[MoqFilterType2["LATEST_OBJECT"] = 2] = "LATEST_OBJECT";\n  MoqFilterType2[MoqFilterType2["ABSOLUTE_START"] = 3] = "ABSOLUTE_START";\n  MoqFilterType2[MoqFilterType2["ABSOLUTE_RANGE"] = 4] = "ABSOLUTE_RANGE";\n  return MoqFilterType2;\n})(MoqFilterType || {});\nvar MoqGroupOrder = /* @__PURE__ */ ((MoqGroupOrder2) => {\n  MoqGroupOrder2[MoqGroupOrder2["NONE"] = 0] = "NONE";\n  MoqGroupOrder2[MoqGroupOrder2["ASCENDING"] = 1] = "ASCENDING";\n  MoqGroupOrder2[MoqGroupOrder2["DESCENDING"] = 2] = "DESCENDING";\n  return MoqGroupOrder2;\n})(MoqGroupOrder || {});\nfunction encodeVarint(value) {\n  const n = BigInt(value);\n  if (n < 64n) {\n    return new Uint8Array([Number(n)]);\n  } else if (n < 16384n) {\n    return new Uint8Array([Number(n >> 8n | 0x40n), Number(n & 0xffn)]);\n  } else if (n < 1073741824n) {\n    return new Uint8Array([\n      Number(n >> 24n | 0x80n),\n      Number(n >> 16n & 0xffn),\n      Number(n >> 8n & 0xffn),\n      Number(n & 0xffn)\n    ]);\n  } else {\n    return new Uint8Array([\n      Number(n >> 56n | 0xc0n),\n      Number(n >> 48n & 0xffn),\n      Number(n >> 40n & 0xffn),\n      Number(n >> 32n & 0xffn),\n      Number(n >> 24n & 0xffn),\n      Number(n >> 16n & 0xffn),\n      Number(n >> 8n & 0xffn),\n      Number(n & 0xffn)\n    ]);\n  }\n}\nfunction decodeVarint(data, offset = 0) {\n  if (offset >= data.length) {\n    throw new Error("Not enough data to decode varint");\n  }\n  const firstByte = data[offset];\n  const prefix = firstByte >> 6;\n  switch (prefix) {\n    case 0: {\n      return { value: BigInt(firstByte), bytesRead: 1 };\n    }\n    case 1: {\n      if (offset + 2 > data.length) {\n        throw new Error("Not enough data for 2-byte varint");\n      }\n      const value = BigInt((firstByte & 63) << 8) | BigInt(data[offset + 1]);\n      return { value, bytesRead: 2 };\n    }\n    case 2: {\n      if (offset + 4 > data.length) {\n        throw new Error("Not enough data for 4-byte varint");\n      }\n      const value = BigInt(firstByte & 63) << 24n | BigInt(data[offset + 1]) << 16n | BigInt(data[offset + 2]) << 8n | BigInt(data[offset + 3]);\n      return { value, bytesRead: 4 };\n    }\n    case 3: {\n      if (offset + 8 > data.length) {\n        throw new Error("Not enough data for 8-byte varint");\n      }\n      const value = BigInt(firstByte & 63) << 56n | BigInt(data[offset + 1]) << 48n | BigInt(data[offset + 2]) << 40n | BigInt(data[offset + 3]) << 32n | BigInt(data[offset + 4]) << 24n | BigInt(data[offset + 5]) << 16n | BigInt(data[offset + 6]) << 8n | BigInt(data[offset + 7]);\n      return { value, bytesRead: 8 };\n    }\n    default:\n      throw new Error("Invalid varint prefix");\n  }\n}\nconst textEncoder$1 = new TextEncoder();\nconst textDecoder = new TextDecoder();\nfunction encodeString(str) {\n  const bytes = textEncoder$1.encode(str);\n  const lengthBytes = encodeVarint(bytes.length);\n  const result = new Uint8Array(lengthBytes.length + bytes.length);\n  result.set(lengthBytes, 0);\n  result.set(bytes, lengthBytes.length);\n  return result;\n}\nfunction decodeString(data, offset = 0) {\n  const { value: length, bytesRead: lengthBytes } = decodeVarint(data, offset);\n  const stringLength = Number(length);\n  const stringStart = offset + lengthBytes;\n  const stringEnd = stringStart + stringLength;\n  if (stringEnd > data.length) {\n    throw new Error("Not enough data for string");\n  }\n  const value = textDecoder.decode(data.subarray(stringStart, stringEnd));\n  return { value, bytesRead: lengthBytes + stringLength };\n}\nfunction encodeBytes(bytes) {\n  const lengthBytes = encodeVarint(bytes.length);\n  const result = new Uint8Array(lengthBytes.length + bytes.length);\n  result.set(lengthBytes, 0);\n  result.set(bytes, lengthBytes.length);\n  return result;\n}\nfunction decodeBytes(data, offset = 0) {\n  const { value: length, bytesRead: lengthBytes } = decodeVarint(data, offset);\n  const bytesLength = Number(length);\n  const bytesStart = offset + lengthBytes;\n  const bytesEnd = bytesStart + bytesLength;\n  if (bytesEnd > data.length) {\n    throw new Error("Not enough data for bytes");\n  }\n  const value = data.subarray(bytesStart, bytesEnd);\n  return { value, bytesRead: lengthBytes + bytesLength };\n}\nclass MessageBuilder {\n  chunks = [];\n  totalLength = 0;\n  /**\n   * Append a varint to the message\n   */\n  writeVarint(value) {\n    const bytes = encodeVarint(value);\n    this.chunks.push(bytes);\n    this.totalLength += bytes.length;\n    return this;\n  }\n  /**\n   * Append a length-prefixed string to the message\n   */\n  writeString(str) {\n    const bytes = encodeString(str);\n    this.chunks.push(bytes);\n    this.totalLength += bytes.length;\n    return this;\n  }\n  /**\n   * Append length-prefixed bytes to the message\n   */\n  writeBytes(data) {\n    const bytes = encodeBytes(data);\n    this.chunks.push(bytes);\n    this.totalLength += bytes.length;\n    return this;\n  }\n  /**\n   * Append raw bytes (no length prefix) to the message\n   */\n  writeRaw(data) {\n    this.chunks.push(data);\n    this.totalLength += data.length;\n    return this;\n  }\n  /**\n   * Build the final message\n   */\n  build() {\n    const result = new Uint8Array(this.totalLength);\n    let offset = 0;\n    for (const chunk of this.chunks) {\n      result.set(chunk, offset);\n      offset += chunk.length;\n    }\n    return result;\n  }\n}\nfunction wrapWithLengthFrame(messageType, content) {\n  const typeBytes = encodeVarint(messageType);\n  const length = content.length;\n  const lengthBytes = new Uint8Array(2);\n  lengthBytes[0] = length >> 8 & 255;\n  lengthBytes[1] = length & 255;\n  const result = new Uint8Array(typeBytes.length + 2 + content.length);\n  result.set(typeBytes, 0);\n  result.set(lengthBytes, typeBytes.length);\n  result.set(content, typeBytes.length + 2);\n  return result;\n}\nfunction encodeParams(builder, params) {\n  const sorted = [...params].sort((a, b) => a.type - b.type);\n  builder.writeVarint(sorted.length);\n  let prev = 0;\n  for (const p of sorted) {\n    builder.writeVarint(p.type - prev);\n    prev = p.type;\n    if (p.type % 2 === 1) {\n      const bytes = p.value;\n      builder.writeVarint(bytes.length);\n      builder.writeRaw(bytes);\n    } else {\n      builder.writeVarint(p.value);\n    }\n  }\n}\nfunction decodeParams(data, offset = 0) {\n  let pos = offset;\n  const { value: count, bytesRead: countBytes } = decodeVarint(data, pos);\n  pos += countBytes;\n  const params = /* @__PURE__ */ new Map();\n  let prev = 0;\n  for (let i = 0; i < Number(count); i++) {\n    const { value: delta, bytesRead: deltaBytes } = decodeVarint(data, pos);\n    pos += deltaBytes;\n    const type = prev + Number(delta);\n    prev = type;\n    if (type % 2 === 1) {\n      const { value: blob, bytesRead: blobBytes } = decodeBytes(data, pos);\n      pos += blobBytes;\n      params.set(type, blob);\n    } else {\n      const { value: v, bytesRead: vBytes } = decodeVarint(data, pos);\n      pos += vBytes;\n      params.set(type, v);\n    }\n  }\n  return { params, bytesRead: pos - offset };\n}\nfunction buildClientSetup(_supportedVersions, _role, path, maxSubscribeId, extraParams) {\n  const contentBuilder = new MessageBuilder();\n  const params = [];\n  if (path !== void 0) {\n    params.push({ type: MoqSetupParameter.PATH, value: textEncoder$1.encode(path) });\n  }\n  if (maxSubscribeId !== void 0) {\n    params.push({ type: MoqSetupParameter.MAX_SUBSCRIBE_ID, value: BigInt(maxSubscribeId) });\n  }\n  if (extraParams) {\n    params.push(...extraParams);\n  }\n  encodeParams(contentBuilder, params);\n  return wrapWithLengthFrame(MoqMessageType.CLIENT_SETUP, contentBuilder.build());\n}\nconst SUB_PARAM_FORWARD = 16;\nconst SUB_PARAM_PRIORITY = 32;\nconst SUB_PARAM_FILTER = 33;\nconst SUB_PARAM_GROUP_ORDER = 34;\nconst SUB_OK_PARAM_EXPIRES = 8;\nconst SUB_OK_PARAM_LARGEST = 9;\nconst PARAM_AUTHORIZATION = 3;\nconst PARAM_RESUME_HLC = 65281;\nfunction buildSubscribe(subscription) {\n  const contentBuilder = new MessageBuilder();\n  contentBuilder.writeVarint(subscription.subscribeId);\n  contentBuilder.writeVarint(subscription.namespace.length);\n  for (const part of subscription.namespace) {\n    contentBuilder.writeString(part);\n  }\n  contentBuilder.writeString(subscription.trackName);\n  const params = [];\n  params.push({ type: SUB_PARAM_PRIORITY, value: BigInt(subscription.subscriberPriority ?? 128) });\n  params.push({ type: SUB_PARAM_GROUP_ORDER, value: BigInt(subscription.groupOrder ?? MoqGroupOrder.ASCENDING) });\n  params.push({ type: SUB_PARAM_FORWARD, value: BigInt(subscription.forward ?? 1) });\n  const filterBuilder = new MessageBuilder();\n  filterBuilder.writeVarint(subscription.filterType);\n  params.push({ type: SUB_PARAM_FILTER, value: filterBuilder.build() });\n  if (subscription.authorization) {\n    params.push({ type: PARAM_AUTHORIZATION, value: textEncoder$1.encode(subscription.authorization) });\n  }\n  if (subscription.resumeOpId !== void 0 && subscription.resumeOpId > 0n) {\n    const opIdBuf = new Uint8Array(8);\n    new DataView(opIdBuf.buffer).setBigUint64(0, subscription.resumeOpId, false);\n    params.push({ type: PARAM_RESUME_HLC, value: opIdBuf });\n  }\n  if (subscription.extraParams) {\n    params.push(...subscription.extraParams);\n  }\n  encodeParams(contentBuilder, params);\n  return wrapWithLengthFrame(MoqMessageType.SUBSCRIBE, contentBuilder.build());\n}\nfunction buildAnnounce(announcement) {\n  const contentBuilder = new MessageBuilder();\n  contentBuilder.writeVarint(announcement.requestId);\n  contentBuilder.writeVarint(announcement.namespace.length);\n  for (const part of announcement.namespace) {\n    contentBuilder.writeString(part);\n  }\n  const params = [];\n  if (announcement.parameters) {\n    for (const [key, value] of announcement.parameters) {\n      params.push({ type: key, value });\n    }\n  }\n  encodeParams(contentBuilder, params);\n  return wrapWithLengthFrame(MoqMessageType.ANNOUNCE, contentBuilder.build());\n}\nfunction writeVarintInto(buf, offset, value) {\n  if (typeof value === "number") {\n    if (!Number.isInteger(value) || value < 0) {\n      throw new RangeError(`writeVarintInto: value must be a non-negative integer, got ${value}`);\n    }\n    if (value < 64) {\n      buf[offset] = value;\n      return offset + 1;\n    }\n    if (value < 16384) {\n      buf[offset] = value >> 8 | 64;\n      buf[offset + 1] = value & 255;\n      return offset + 2;\n    }\n    if (value < 1073741824) {\n      buf[offset] = value >>> 24 | 128;\n      buf[offset + 1] = value >>> 16 & 255;\n      buf[offset + 2] = value >>> 8 & 255;\n      buf[offset + 3] = value & 255;\n      return offset + 4;\n    }\n    value = BigInt(value);\n  }\n  const n = value;\n  if (n < 0n) {\n    throw new RangeError(`writeVarintInto: value must be non-negative, got ${n}`);\n  }\n  if (n < 0x40n) {\n    buf[offset] = Number(n);\n    return offset + 1;\n  }\n  if (n < 0x4000n) {\n    buf[offset] = Number(n >> 8n | 0x40n);\n    buf[offset + 1] = Number(n & 0xffn);\n    return offset + 2;\n  }\n  if (n < 0x40000000n) {\n    buf[offset] = Number(n >> 24n | 0x80n);\n    buf[offset + 1] = Number(n >> 16n & 0xffn);\n    buf[offset + 2] = Number(n >> 8n & 0xffn);\n    buf[offset + 3] = Number(n & 0xffn);\n    return offset + 4;\n  }\n  buf[offset] = Number(n >> 56n | 0xc0n);\n  buf[offset + 1] = Number(n >> 48n & 0xffn);\n  buf[offset + 2] = Number(n >> 40n & 0xffn);\n  buf[offset + 3] = Number(n >> 32n & 0xffn);\n  buf[offset + 4] = Number(n >> 24n & 0xffn);\n  buf[offset + 5] = Number(n >> 16n & 0xffn);\n  buf[offset + 6] = Number(n >> 8n & 0xffn);\n  buf[offset + 7] = Number(n & 0xffn);\n  return offset + 8;\n}\nfunction maxObjectDatagramSize(maxPayload) {\n  return 1 + 8 + 8 + 8 + 1 + maxPayload;\n}\nfunction encodeObjectDatagramInto(buf, trackAlias, groupId, objectId, publisherPriority, payload) {\n  let pos = 0;\n  pos = writeVarintInto(buf, pos, 0);\n  pos = writeVarintInto(buf, pos, trackAlias);\n  pos = writeVarintInto(buf, pos, groupId);\n  pos = writeVarintInto(buf, pos, objectId);\n  buf[pos++] = publisherPriority & 255;\n  buf.set(payload, pos);\n  return pos + payload.length;\n}\nfunction parseServerSetup(data, offset = 0) {\n  const { params } = decodeParams(data, offset);\n  const parameters = /* @__PURE__ */ new Map();\n  for (const [type, value] of params) {\n    parameters.set(type, value instanceof Uint8Array ? value : encodeVarint(value));\n  }\n  return {\n    selectedVersion: MOQ_TRANSPORT_VERSION,\n    parameters\n  };\n}\nfunction parseSubscribeOk(data, offset = 0) {\n  let pos = offset;\n  const { value: subscribeId, bytesRead: subIdBytes } = decodeVarint(data, pos);\n  pos += subIdBytes;\n  const { value: trackAlias, bytesRead: aliasBytes } = decodeVarint(data, pos);\n  pos += aliasBytes;\n  const { params } = decodeParams(data, pos);\n  const result = {\n    subscribeId: Number(subscribeId),\n    trackAlias: Number(trackAlias),\n    expires: 0n,\n    groupOrder: 0,\n    contentExists: false\n  };\n  const expires = params.get(SUB_OK_PARAM_EXPIRES);\n  if (typeof expires === "bigint") result.expires = expires;\n  const groupOrder = params.get(SUB_PARAM_GROUP_ORDER);\n  if (typeof groupOrder === "bigint") result.groupOrder = Number(groupOrder);\n  const largest = params.get(SUB_OK_PARAM_LARGEST);\n  if (largest instanceof Uint8Array) {\n    result.contentExists = true;\n    const g = decodeVarint(largest, 0);\n    const o = decodeVarint(largest, g.bytesRead);\n    result.largestGroupId = g.value;\n    result.largestObjectId = o.value;\n  }\n  return result;\n}\nfunction parseSubscribeError(data, offset = 0) {\n  let pos = offset;\n  const { value: subscribeId, bytesRead: subIdBytes } = decodeVarint(data, pos);\n  pos += subIdBytes;\n  const { value: errorCode, bytesRead: errorCodeBytes } = decodeVarint(data, pos);\n  pos += errorCodeBytes;\n  const { bytesRead: retryBytes } = decodeVarint(data, pos);\n  pos += retryBytes;\n  const { value: reasonPhrase } = decodeString(data, pos);\n  return {\n    subscribeId: Number(subscribeId),\n    errorCode: Number(errorCode),\n    reasonPhrase,\n    trackAlias: 0\n  };\n}\nfunction parseAnnounceOk(data, offset = 0) {\n  const { value: requestId } = decodeVarint(data, offset);\n  return { requestId: Number(requestId) };\n}\nfunction parseAnnounceError(data, offset = 0) {\n  let pos = offset;\n  const { value: nsLength, bytesRead: nsLengthBytes } = decodeVarint(data, pos);\n  pos += nsLengthBytes;\n  const namespace = [];\n  for (let i = 0; i < Number(nsLength); i++) {\n    const { value: part, bytesRead: partBytes } = decodeString(data, pos);\n    pos += partBytes;\n    namespace.push(part);\n  }\n  const { value: errorCode, bytesRead: errorCodeBytes } = decodeVarint(data, pos);\n  pos += errorCodeBytes;\n  const { value: reasonPhrase, bytesRead: reasonBytes } = decodeString(data, pos);\n  pos += reasonBytes;\n  return {\n    namespace,\n    errorCode: Number(errorCode),\n    reasonPhrase\n  };\n}\nfunction parseObjectDatagram(data, offset = 0) {\n  let pos = offset;\n  const { value: _type, bytesRead: typeBytes } = decodeVarint(data, pos);\n  pos += typeBytes;\n  const { value: trackAlias, bytesRead: aliasBytes } = decodeVarint(data, pos);\n  pos += aliasBytes;\n  const { value: groupId, bytesRead: groupIdBytes } = decodeVarint(data, pos);\n  pos += groupIdBytes;\n  const { value: objectId, bytesRead: objectIdBytes } = decodeVarint(data, pos);\n  pos += objectIdBytes;\n  if (pos >= data.length) {\n    throw new Error("Not enough data for publisher priority");\n  }\n  const publisherPriority = data[pos];\n  pos += 1;\n  const payload = data.subarray(pos);\n  return {\n    trackAlias: Number(trackAlias),\n    groupId,\n    objectId,\n    publisherPriority,\n    payload\n  };\n}\nconst MOQ_TRANSPORT_VERSION = 4278190080 + 16;\nconst PENDING_DATAGRAM_MAX_BYTES = 1 * 1024 * 1024;\nclass DatagramRouter {\n  handlers = /* @__PURE__ */ new Map();\n  // Pre-handler buffer, FIFO across all aliases; oldest dropped when the byte cap\n  // is exceeded. Cleared on clear().\n  pending = [];\n  pendingBytes = 0;\n  /**\n   * Register a handler for a track alias and drain any datagrams that arrived for\n   * it before registration (the SUBSCRIBE_OK race), in arrival order.\n   */\n  register(trackAlias, handler) {\n    this.handlers.set(trackAlias, handler);\n    if (this.pending.length > 0) this.drainForAlias(trackAlias, handler);\n  }\n  /** Unregister a handler and discard any still-buffered datagrams for its alias. */\n  unregister(trackAlias) {\n    this.handlers.delete(trackAlias);\n    if (this.pending.length > 0) this.discardForAlias(trackAlias);\n  }\n  /** Route a parsed datagram to its handler, or buffer it if none is registered yet. */\n  ingest(d) {\n    const handler = this.handlers.get(d.trackAlias);\n    if (handler) {\n      handler(d.payload, d.trackAlias, d.groupId, d.objectId);\n    } else {\n      this.bufferUnknown(d);\n    }\n  }\n  // DatagramReceiver surface (same names as MoqConnection) so subscribers can take\n  // either. These are the public aliases of register()/unregister().\n  registerDatagramHandler(trackAlias, handler) {\n    this.register(trackAlias, handler);\n  }\n  unregisterDatagramHandler(trackAlias) {\n    this.unregister(trackAlias);\n  }\n  /** Number of buffered pre-handler datagrams (tests/diagnostics). */\n  pendingCount() {\n    return this.pending.length;\n  }\n  /** Drop all handlers + buffered datagrams (connection close). */\n  clear() {\n    this.handlers.clear();\n    this.pending = [];\n    this.pendingBytes = 0;\n  }\n  drainForAlias(trackAlias, handler) {\n    const remaining = [];\n    let drainedBytes = 0;\n    for (const d of this.pending) {\n      if (d.trackAlias === trackAlias) {\n        try {\n          handler(d.payload, d.trackAlias, d.groupId, d.objectId);\n        } catch {\n        }\n        drainedBytes += d.payload.length;\n      } else {\n        remaining.push(d);\n      }\n    }\n    this.pending = remaining;\n    this.pendingBytes -= drainedBytes;\n  }\n  discardForAlias(trackAlias) {\n    const remaining = [];\n    let discardedBytes = 0;\n    for (const d of this.pending) {\n      if (d.trackAlias === trackAlias) {\n        discardedBytes += d.payload.length;\n      } else {\n        remaining.push(d);\n      }\n    }\n    this.pending = remaining;\n    this.pendingBytes -= discardedBytes;\n  }\n  bufferUnknown(d) {\n    this.pending.push(d);\n    this.pendingBytes += d.payload.length;\n    while (this.pendingBytes > PENDING_DATAGRAM_MAX_BYTES && this.pending.length > 0) {\n      const dropped = this.pending.shift();\n      this.pendingBytes -= dropped.payload.length;\n    }\n  }\n}\nclass MoqConnection {\n  constructor(serverUrl, debug2 = false) {\n    this.serverUrl = serverUrl;\n    this.debug = debug2;\n  }\n  transport = null;\n  state = ConnectionState.DISCONNECTED;\n  handlers = {};\n  datagramWriter = null;\n  // Main-thread datagram path: the read loop lives here, the\n  // trackAlias->handler routing and the SUBSCRIBE_OK race buffer in the\n  // router. LasaClient never uses it (the worker owns the read loop and\n  // the client routes through its own DatagramRouter); it is the raw\n  // MoqConnection + MoqSession usage, exercised by interop/main.ts.\n  router = new DatagramRouter();\n  datagramDispatcherRunning = false;\n  // \'worker\' once takeDatagramReadableForWorker() has handed the\n  // readable to the receive Worker; the main dispatcher then never starts.\n  datagramMode = "main";\n  /**\n   * Get current connection state\n   */\n  getState() {\n    return this.state;\n  }\n  /**\n   * Get the underlying WebTransport instance\n   */\n  getTransport() {\n    return this.transport;\n  }\n  /**\n   * Set event handlers\n   */\n  setHandlers(handlers) {\n    this.handlers = { ...this.handlers, ...handlers };\n  }\n  /**\n   * Connect to the MOQ server via WebTransport\n   */\n  async connect(options) {\n    if (this.state !== ConnectionState.DISCONNECTED) {\n      throw new Error(`Cannot connect: already in state ${this.state}`);\n    }\n    this.setState(ConnectionState.CONNECTING);\n    try {\n      const wtOptions = {\n        allowPooling: false,\n        requireUnreliable: true,\n        // We use datagrams for audio\n        congestionControl: "low-latency",\n        // Negotiate the MOQ draft-16 subprotocol over WebTransport so the server\n        // selects draft-16 (it falls back to draft-14 if no subprotocol is set).\n        protocols: ["moqt-16"],\n        ...options\n      };\n      try {\n        this.transport = await this.openTransport(wtOptions);\n      } catch (firstError) {\n        if (wtOptions.protocols === void 0) throw firstError;\n        if (this.debug) {\n          console.log(\n            `[MOQ] WebTransport connect failed with protocols=${JSON.stringify(wtOptions.protocols)} (${String(firstError)}) — retrying without subprotocol negotiation`\n          );\n        }\n        const { protocols: _omitted, ...withoutProtocols } = wtOptions;\n        this.transport = await this.openTransport(withoutProtocols);\n      }\n      if (this.debug) {\n        console.log(\n          `[MOQ] WebTransport ready — negotiated subprotocol: ${JSON.stringify(this.getNegotiatedSubprotocol())}`\n        );\n      }\n      this.setState(ConnectionState.CONNECTED);\n    } catch (error) {\n      this.setState(ConnectionState.ERROR, error);\n      throw error;\n    }\n  }\n  /**\n   * Open one WebTransport and await `ready`; wires the close handler. On\n   * failure the instance is discarded (closed defensively) so connect() can\n   * retry with different options.\n   */\n  async openTransport(wtOptions) {\n    const transport = new WebTransport(this.serverUrl, wtOptions);\n    try {\n      await transport.ready;\n    } catch (error) {\n      transport.closed.catch(() => void 0);\n      try {\n        transport.close();\n      } catch {\n      }\n      throw error;\n    }\n    transport.closed.then((info) => {\n      this.handleClose(info);\n    }).catch((error) => {\n      this.handleError(error);\n    });\n    return transport;\n  }\n  /**\n   * The WebTransport subprotocol the server selected (\'moqt-16\' when draft-16\n   * negotiation worked; empty/undefined on engines without subprotocol support).\n   * Null before connect. Used by the stereo diagnostics snapshot.\n   */\n  getNegotiatedSubprotocol() {\n    if (!this.transport) return null;\n    return this.transport.protocol ?? null;\n  }\n  /**\n   * Close the connection gracefully\n   */\n  close(closeInfo) {\n    this.datagramDispatcherRunning = false;\n    this.datagramMode = "main";\n    this.router.clear();\n    if (this.datagramWriter) {\n      this.datagramWriter.releaseLock();\n      this.datagramWriter = null;\n    }\n    if (this.transport) {\n      this.transport.close(closeInfo);\n      this.transport = null;\n    }\n    this.setState(ConnectionState.DISCONNECTED);\n  }\n  /**\n   * Create a bidirectional stream for the MOQ control channel\n   */\n  async createControlStream() {\n    if (!this.transport) {\n      throw new Error("Not connected");\n    }\n    return this.transport.createBidirectionalStream();\n  }\n  /**\n   * Create a unidirectional stream for sending data\n   */\n  async createSendStream() {\n    if (!this.transport) {\n      throw new Error("Not connected");\n    }\n    return this.transport.createUnidirectionalStream();\n  }\n  /**\n   * Send a datagram (used for audio frames)\n   */\n  async sendDatagram(data) {\n    if (!this.transport) {\n      throw new Error("Not connected");\n    }\n    if (data.length === 0) {\n      return;\n    }\n    if (!this.datagramWriter) {\n      const dg = this.transport.datagrams;\n      const writable = dg.writable ?? dg.createWritable?.();\n      if (!writable) {\n        throw new Error("WebTransport datagrams are not writable in this browser");\n      }\n      this.datagramWriter = writable.getWriter();\n    }\n    try {\n      await this.datagramWriter.write(data);\n    } catch (error) {\n      try {\n        this.datagramWriter.releaseLock();\n      } catch {\n      }\n      this.datagramWriter = null;\n      throw error;\n    }\n  }\n  /**\n   * Switch to worker datagram mode (design §11.4): the receive Worker reads the\n   * datagram readable, so the main dispatcher must NOT. Returns the unlocked\n   * `datagrams.readable` for transfer into the worker. Must be called before any\n   * `registerDatagramHandler` (which would otherwise start the main dispatcher\n   * and lock the stream). Returns null if not connected.\n   */\n  takeDatagramReadableForWorker() {\n    if (!this.transport) return null;\n    if (this.datagramDispatcherRunning) {\n      throw new Error("Cannot switch to worker datagram mode: main dispatcher already reading");\n    }\n    this.datagramMode = "worker";\n    return this.transport.datagrams.readable;\n  }\n  /**\n   * Register a datagram handler for a specific track alias. Starts the dispatcher\n   * on first registration (transport concern); the router drains any datagrams\n   * that arrived for this alias before registration (the SUBSCRIBE_OK race).\n   */\n  registerDatagramHandler(trackAlias, handler) {\n    if (!this.datagramDispatcherRunning) {\n      this.startDatagramDispatcher();\n    }\n    this.router.register(trackAlias, handler);\n  }\n  /** Unregister a datagram handler; the router discards any still-buffered datagrams for it. */\n  unregisterDatagramHandler(trackAlias) {\n    this.router.unregister(trackAlias);\n  }\n  /**\n   * Start the single datagram reader loop that dispatches to handlers by track alias\n   */\n  startDatagramDispatcher() {\n    if (this.datagramMode === "worker") {\n      return;\n    }\n    if (this.datagramDispatcherRunning || !this.transport) {\n      return;\n    }\n    this.datagramDispatcherRunning = true;\n    const reader = this.transport.datagrams.readable.getReader();\n    const loop = async () => {\n      try {\n        while (this.datagramDispatcherRunning) {\n          const { value, done } = await reader.read();\n          if (done) break;\n          if (!value) continue;\n          try {\n            const parsed = parseObjectDatagram(value);\n            this.router.ingest(parsed);\n          } catch {\n          }\n        }\n      } catch (error) {\n        if (this.datagramDispatcherRunning) {\n          console.error("Datagram dispatcher error:", error);\n        }\n      } finally {\n        this.datagramDispatcherRunning = false;\n      }\n    };\n    loop();\n  }\n  /**\n   * Update connection state and notify handlers\n   */\n  setState(state, error) {\n    this.state = state;\n    if (this.handlers.onStateChange) {\n      this.handlers.onStateChange(state, error);\n    }\n  }\n  /**\n   * Handle connection close\n   */\n  handleClose(info) {\n    if (this.datagramWriter) {\n      try {\n        this.datagramWriter.releaseLock();\n      } catch {\n      }\n      this.datagramWriter = null;\n    }\n    this.transport = null;\n    this.setState(ConnectionState.DISCONNECTED);\n    if (this.handlers.onClose) {\n      this.handlers.onClose(info);\n    }\n  }\n  /**\n   * Handle connection error\n   */\n  handleError(error) {\n    console.error("WebTransport connection error:", error);\n    if (this.datagramWriter) {\n      try {\n        this.datagramWriter.releaseLock();\n      } catch {\n      }\n      this.datagramWriter = null;\n    }\n    this.transport = null;\n    this.setState(ConnectionState.ERROR, error);\n  }\n}\nclass MoqClientError extends Error {\n  constructor(message, code, details) {\n    super(message);\n    this.code = code;\n    this.details = details;\n    this.name = "MoqClientError";\n  }\n}\nclass AuthenticationError extends MoqClientError {\n  constructor(message, moqErrorCode, details) {\n    super(message, "AUTHENTICATION_FAILED", details);\n    this.moqErrorCode = moqErrorCode;\n    this.name = "AuthenticationError";\n  }\n  /**\n   * Check if this is an invalid token error\n   */\n  isInvalidToken() {\n    return this.moqErrorCode !== void 0 && isSubscribeAuthError(this.moqErrorCode);\n  }\n  /**\n   * Check if this is an expired token error\n   */\n  isExpiredToken() {\n    return this.message.toLowerCase().includes("expired");\n  }\n}\nclass ProtocolError extends MoqClientError {\n  constructor(message, moqErrorCode, details) {\n    super(message, "PROTOCOL_ERROR", details);\n    this.moqErrorCode = moqErrorCode;\n    this.name = "ProtocolError";\n  }\n}\nclass SubscriptionError extends MoqClientError {\n  constructor(message, moqErrorCode, trackNamespace, details) {\n    super(message, "SUBSCRIPTION_FAILED", details);\n    this.moqErrorCode = moqErrorCode;\n    this.trackNamespace = trackNamespace;\n    this.name = "SubscriptionError";\n  }\n}\nclass AnnouncementError extends MoqClientError {\n  constructor(message, moqErrorCode, namespace, details) {\n    super(message, "ANNOUNCEMENT_FAILED", details);\n    this.moqErrorCode = moqErrorCode;\n    this.namespace = namespace;\n    this.name = "AnnouncementError";\n  }\n}\nfunction getMoqErrorMessage(code) {\n  switch (code) {\n    case 0:\n      return "No error";\n    case 1:\n      return "Internal error";\n    case 2:\n      return "Unauthorized";\n    case 3:\n      return "Protocol violation";\n    case 4:\n      return "Invalid request ID";\n    case 5:\n      return "Duplicate track alias";\n    case 6:\n      return "Key-value formatting error";\n    case 7:\n      return "Too many requests";\n    case 8:\n      return "Invalid path";\n    case 9:\n      return "Malformed path";\n    case 16:\n      return "GOAWAY timeout";\n    case 17:\n      return "Control message timeout";\n    case 18:\n      return "Data stream timeout";\n    case 19:\n      return "Auth token cache overflow";\n    case 20:\n      return "Duplicate auth token alias";\n    case 21:\n      return "Version negotiation failed";\n    case 22:\n      return "Malformed auth token";\n    case 23:\n      return "Unknown auth token alias";\n    default:\n      return `Unknown error (0x${code.toString(16)})`;\n  }\n}\nfunction getSubscribeErrorMessage(code) {\n  switch (code) {\n    case 0:\n      return "Internal error";\n    case 1:\n      return "Unauthorized";\n    case 2:\n      return "Timeout";\n    case 3:\n      return "Not supported";\n    case 4:\n      return "Track does not exist";\n    case 5:\n      return "Invalid range";\n    case 16:\n      return "Malformed auth token";\n    case 18:\n      return "Expired auth token";\n    case 1027:\n      return "Invalid token (custom)";\n    default:\n      return `Unknown subscribe error (0x${code.toString(16)})`;\n  }\n}\nfunction isSubscribeAuthError(code) {\n  return code === 1 || code === 16 || code === 18 || code === 1027;\n}\nclass MoqSession {\n  constructor(connection, debug2 = false) {\n    this.connection = connection;\n    this.debug = debug2;\n  }\n  controlStream = null;\n  writer = null;\n  reader = null;\n  readBuffer = new Uint8Array(0);\n  nextSubscribeId = 1;\n  nextTrackAlias = 1;\n  nextAnnounceRequestId = 2;\n  // Client uses even IDs for announces (to avoid collisions with server)\n  // Track state\n  subscriptions = /* @__PURE__ */ new Map();\n  announcements = /* @__PURE__ */ new Map();\n  incomingSubscriptions = /* @__PURE__ */ new Map();\n  // Callbacks for when server subscribes to our tracks\n  onIncomingSubscribeCallback = null;\n  // PUBLISH_DONE (0x0B) dispatch, keyed by the subscribe request id\n  // (divergence 4, PROVENANCE.md): the server ends a subscription\n  // instance natively — LASA\'s state plane uses too-far-behind (0x06)\n  // as the re-subscribe cue.\n  publishDoneHandlers = /* @__PURE__ */ new Map();\n  debug;\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  log(...args) {\n    if (this.debug) {\n      console.log("[MOQ]", ...args);\n    }\n  }\n  /**\n   * Set callback for when server subscribes to one of our announced tracks\n   */\n  onIncomingSubscribe(callback) {\n    this.onIncomingSubscribeCallback = callback;\n  }\n  /**\n   * Register a handler for PUBLISH_DONE on a subscription (by the\n   * subscribe id returned from subscribe()). One-shot per instance.\n   */\n  onPublishDone(subscribeId, handler) {\n    this.publishDoneHandlers.set(subscribeId, handler);\n  }\n  removePublishDoneHandler(subscribeId) {\n    this.publishDoneHandlers.delete(subscribeId);\n  }\n  /**\n   * Initialize the MOQ session over the control stream\n   * @param role - The MOQ role (publisher, subscriber, or pubsub)\n   * @param path - Optional path parameter\n   * @param maxSubscribeId - Max number of requests server can send to client (default: 100)\n   */\n  async initialize(role, path, maxSubscribeId = 100, extraSetupParams) {\n    this.log("Creating control stream...");\n    this.controlStream = await this.connection.createControlStream();\n    this.writer = this.controlStream.writable.getWriter();\n    this.reader = this.controlStream.readable.getReader();\n    this.log("Control stream created, sending CLIENT_SETUP...");\n    const setupMsg = buildClientSetup([MOQ_TRANSPORT_VERSION], role, path, maxSubscribeId, extraSetupParams);\n    this.log("CLIENT_SETUP message size:", setupMsg.length, "bytes");\n    this.log("CLIENT_SETUP hex:", Array.from(setupMsg).map((b) => b.toString(16).padStart(2, "0")).join(" "));\n    await this.writer.write(setupMsg);\n    this.log("CLIENT_SETUP sent, waiting for SERVER_SETUP...");\n    const { type, content } = await this.readFramedMessage();\n    this.log("Received response type: 0x" + type.toString(16) + ", content size:", content.length, "bytes");\n    if (type !== MoqMessageType.SERVER_SETUP) {\n      throw new ProtocolError(\n        `Expected SERVER_SETUP (0x41), got message type 0x${type.toString(16)}`,\n        type\n      );\n    }\n    const serverSetup = parseServerSetup(content, 0);\n    this.log("Session established, server version:", serverSetup.selectedVersion.toString(16));\n  }\n  /**\n   * Subscribe to a track with JWT authorization\n   */\n  async subscribe(namespace, trackName, authorization, resumeOpId, extraParams) {\n    const subscribeId = this.nextSubscribeId++;\n    const subscribeMsg = buildSubscribe({\n      subscribeId,\n      namespace,\n      trackName,\n      filterType: MoqFilterType.LATEST_GROUP,\n      authorization,\n      resumeOpId,\n      extraParams\n    });\n    this.log("SUBSCRIBE message size:", subscribeMsg.length, "bytes");\n    await this.writer.write(subscribeMsg);\n    const { type, content } = await this.waitForMessage([\n      MoqMessageType.SUBSCRIBE_OK,\n      MoqMessageType.SUBSCRIBE_ERROR\n    ]);\n    if (type === MoqMessageType.SUBSCRIBE_OK) {\n      const ok = parseSubscribeOk(content, 0);\n      this.log("Subscribed successfully, subscribeId:", ok.subscribeId, "trackAlias:", ok.trackAlias);\n      this.subscriptions.set(subscribeId, { namespace, trackName, alias: ok.trackAlias });\n      return subscribeId;\n    } else if (type === MoqMessageType.SUBSCRIBE_ERROR) {\n      const error = parseSubscribeError(content, 0);\n      const errorMessage = `${error.reasonPhrase} (${getSubscribeErrorMessage(error.errorCode)})`;\n      if (isSubscribeAuthError(error.errorCode)) {\n        throw new AuthenticationError(errorMessage, error.errorCode, { namespace, trackName });\n      }\n      throw new SubscriptionError(errorMessage, error.errorCode, namespace);\n    } else {\n      throw new ProtocolError(\n        `Expected SUBSCRIBE_OK or SUBSCRIBE_ERROR, got message type 0x${type.toString(16)}`,\n        type\n      );\n    }\n  }\n  // Single-reader dispatch (divergence 2, PROVENANCE.md): once the\n  // background message loop is running it is the ONLY reader of the\n  // control stream; waiters for a response register here and the loop\n  // fulfils them. Two concurrent readers steal each other\'s messages —\n  // the LASA client keeps the loop running for the whole session (the\n  // server may subscribe our tracks at any time), so subscribe/announce\n  // must not read inline after start.\n  pendingResponses = [];\n  messageLoopRunning = false;\n  /**\n   * Wait for a specific message type. Before the message loop starts,\n   * reads inline (handling unrelated messages that arrive first); once\n   * the loop runs, registers with the single-reader dispatch instead.\n   */\n  async waitForMessage(expectedTypes) {\n    if (this.messageLoopRunning) {\n      return new Promise((resolve, reject) => {\n        const entry = {\n          types: expectedTypes,\n          resolve: (m) => {\n            clearTimeout(timer);\n            resolve(m);\n          },\n          reject: (e) => {\n            clearTimeout(timer);\n            reject(e);\n          }\n        };\n        const timer = setTimeout(() => {\n          const i = this.pendingResponses.indexOf(entry);\n          if (i >= 0) this.pendingResponses.splice(i, 1);\n          reject(\n            new ProtocolError(\n              `Timeout waiting for message types: ${expectedTypes.map((t) => "0x" + t.toString(16)).join(", ")}`,\n              0\n            )\n          );\n        }, 1e4);\n        this.pendingResponses.push(entry);\n      });\n    }\n    const maxAttempts = 20;\n    for (let i = 0; i < maxAttempts; i++) {\n      const { type, content } = await this.readFramedMessage();\n      if (expectedTypes.includes(type)) {\n        return { type, content };\n      }\n      this.log(`Received unexpected message type 0x${type.toString(16)} while waiting, handling it`);\n      await this.handleUnexpectedMessage(type, content);\n    }\n    throw new ProtocolError(\n      `Timeout waiting for message types: ${expectedTypes.map((t) => "0x" + t.toString(16)).join(", ")}`,\n      0\n    );\n  }\n  /**\n   * Handle messages that arrive when we\'re waiting for something else\n   */\n  async handleUnexpectedMessage(type, content) {\n    switch (type) {\n      case MoqMessageType.ANNOUNCE:\n        this.log("Received ANNOUNCE from server, sending ANNOUNCE_OK");\n        await this.sendAnnounceOk(content);\n        break;\n      case MoqMessageType.SUBSCRIBE_ANNOUNCES:\n        this.log("Received SUBSCRIBE_ANNOUNCES from server, sending OK");\n        await this.sendSubscribeAnnouncesOk(content);\n        break;\n      case MoqMessageType.SUBSCRIBE:\n        this.log("Received SUBSCRIBE from server, sending SUBSCRIBE_OK");\n        await this.handleIncomingSubscribe(content);\n        break;\n      case MoqMessageType.PUBLISH_DONE: {\n        const rid = decodeVarint(content, 0);\n        const status = decodeVarint(content, rid.bytesRead);\n        this.log(`PUBLISH_DONE requestId=${rid.value} status=${status.value}`);\n        const handler = this.publishDoneHandlers.get(Number(rid.value));\n        if (handler) {\n          this.publishDoneHandlers.delete(Number(rid.value));\n          handler(Number(status.value), "");\n        }\n        break;\n      }\n      default:\n        this.log(`Skipping unhandled message type 0x${type.toString(16)}`);\n    }\n  }\n  /**\n   * Handle incoming SUBSCRIBE from server and respond with SUBSCRIBE_OK\n   *\n   * Per moqtransport v0.5.1 / draft-ietf-moq-transport-11, the SUBSCRIBE\n   * wire format does NOT include TrackAlias. The publisher (us) assigns a\n   * TrackAlias and returns it in SUBSCRIBE_OK.\n   *\n   * SUBSCRIBE wire format: RequestID, Namespace, TrackName, Priority,\n   *   GroupOrder, Forward, FilterType, Parameters\n   *\n   * SUBSCRIBE_OK wire format (draft-16): RequestID, TrackAlias, Parameters\n   *   (Expires / GroupOrder / LargestLocation travel as parameters)\n   */\n  async handleIncomingSubscribe(content) {\n    let pos = 0;\n    const rid = decodeVarint(content, pos);\n    const requestId = Number(rid.value);\n    pos += rid.bytesRead;\n    const namespace = this.parseNamespaceFromContent(content, pos);\n    const trackAlias = this.nextTrackAlias++;\n    this.log(`Server subscribing to: ${namespace.join("/")}, assigning trackAlias=${trackAlias}`);\n    const builder = new MessageBuilder();\n    builder.writeVarint(requestId);\n    builder.writeVarint(trackAlias);\n    encodeParams(builder, []);\n    const msg = wrapWithLengthFrame(MoqMessageType.SUBSCRIBE_OK, builder.build());\n    await this.writer.write(msg);\n    this.log("Sent SUBSCRIBE_OK for requestId:", requestId, "trackAlias:", trackAlias);\n    this.incomingSubscriptions.set(requestId, { trackAlias, namespace });\n    if (this.onIncomingSubscribeCallback) {\n      this.onIncomingSubscribeCallback(namespace, trackAlias);\n    }\n  }\n  /**\n   * Get track alias for an incoming subscription by namespace\n   */\n  getIncomingTrackAlias(namespacePrefix) {\n    for (const [, sub] of this.incomingSubscriptions) {\n      if (sub.namespace.join("/").startsWith(namespacePrefix)) {\n        return sub.trackAlias;\n      }\n    }\n    return void 0;\n  }\n  /**\n   * Parse namespace from content starting at given position\n   */\n  parseNamespaceFromContent(content, startPos) {\n    let pos = startPos;\n    const namespace = [];\n    if (pos >= content.length) return namespace;\n    const count = decodeVarint(content, pos);\n    pos += count.bytesRead;\n    for (let i = 0n; i < count.value && pos < content.length; i++) {\n      const part = decodeString(content, pos);\n      namespace.push(part.value);\n      pos += part.bytesRead;\n    }\n    return namespace;\n  }\n  /**\n   * Send ANNOUNCE_OK response\n   */\n  async sendAnnounceOk(announceContent) {\n    const requestId = this.parseRequestId(announceContent);\n    this.log("Sending ANNOUNCE_OK for requestId:", requestId);\n    const builder = new MessageBuilder();\n    builder.writeVarint(requestId);\n    const msg = wrapWithLengthFrame(MoqMessageType.ANNOUNCE_OK, builder.build());\n    this.log("ANNOUNCE_OK message size:", msg.length, "bytes");\n    await this.writer.write(msg);\n  }\n  /**\n   * Send SUBSCRIBE_ANNOUNCES_OK response\n   */\n  async sendSubscribeAnnouncesOk(subscribeAnnouncesContent) {\n    const requestId = this.parseRequestId(subscribeAnnouncesContent);\n    this.log("Sending SUBSCRIBE_ANNOUNCES_OK for requestId:", requestId);\n    const builder = new MessageBuilder();\n    builder.writeVarint(requestId);\n    const msg = wrapWithLengthFrame(MoqMessageType.SUBSCRIBE_ANNOUNCES_OK, builder.build());\n    await this.writer.write(msg);\n  }\n  /**\n   * Parse RequestID (first varint) from message content\n   */\n  parseRequestId(content) {\n    return Number(decodeVarint(content, 0).value);\n  }\n  /**\n   * Announce a track namespace\n   */\n  async announce(namespace, authorization) {\n    const requestId = this.nextAnnounceRequestId;\n    this.nextAnnounceRequestId += 2;\n    const parameters = /* @__PURE__ */ new Map();\n    if (authorization) {\n      const encoder = new TextEncoder();\n      parameters.set(3, encoder.encode(authorization));\n    }\n    const announceMsg = buildAnnounce({ requestId, namespace, parameters: parameters.size > 0 ? parameters : void 0 });\n    this.log("ANNOUNCE message size:", announceMsg.length, "bytes, requestId:", requestId);\n    await this.writer.write(announceMsg);\n    const { type, content } = await this.waitForMessage([\n      MoqMessageType.ANNOUNCE_OK,\n      MoqMessageType.ANNOUNCE_ERROR\n    ]);\n    if (type === MoqMessageType.ANNOUNCE_OK) {\n      const ok = parseAnnounceOk(content, 0);\n      const nsKey = namespace.join("/");\n      this.announcements.set(nsKey, { namespace });\n      this.log("Announced successfully:", nsKey, "requestId:", ok.requestId);\n    } else if (type === MoqMessageType.ANNOUNCE_ERROR) {\n      const error = parseAnnounceError(content, 0);\n      const errorMessage = `${error.reasonPhrase} (${getMoqErrorMessage(error.errorCode)})`;\n      throw new AnnouncementError(errorMessage, error.errorCode, namespace);\n    } else {\n      throw new ProtocolError(\n        `Expected ANNOUNCE_OK or ANNOUNCE_ERROR, got message type 0x${type.toString(16)}`,\n        type\n      );\n    }\n  }\n  /**\n   * Get track alias for a subscription\n   */\n  getTrackAlias(subscribeId) {\n    return this.subscriptions.get(subscribeId)?.alias;\n  }\n  /**\n   * Start background message processing loop\n   * This handles messages that arrive after initial connection setup\n   */\n  startMessageLoop() {\n    this.messageLoopRunning = true;\n    this.processMessages().catch((error) => {\n      this.log("Message loop ended:", error.message);\n    });\n  }\n  /**\n   * Background message processing\n   */\n  async processMessages() {\n    this.log("Starting background message processing loop");\n    while (this.reader) {\n      try {\n        const { type, content } = await this.readFramedMessage();\n        this.log(`Background received message type 0x${type.toString(16)}`);\n        const idx = this.pendingResponses.findIndex((p) => p.types.includes(type));\n        if (idx >= 0) {\n          const [pending] = this.pendingResponses.splice(idx, 1);\n          pending.resolve({ type, content });\n          continue;\n        }\n        try {\n          await this.handleUnexpectedMessage(type, content);\n        } catch (error) {\n          this.log("Handler error for message type 0x" + type.toString(16) + ":", error.message);\n        }\n      } catch (error) {\n        this.log("Message processing stopped:", error.message);\n        for (const p of this.pendingResponses.splice(0)) {\n          p.reject(error);\n        }\n        break;\n      }\n    }\n    this.messageLoopRunning = false;\n  }\n  /**\n   * Close the session\n   */\n  async close() {\n    if (this.writer) {\n      try {\n        await this.writer.close();\n      } catch {\n      }\n      this.writer = null;\n    }\n    if (this.reader) {\n      try {\n        await this.reader.cancel();\n      } catch {\n      }\n      this.reader = null;\n    }\n    this.controlStream = null;\n  }\n  /**\n   * Read a complete message from the control stream with proper length framing\n   * Format: [Type varint] [Length: 2 bytes big-endian] [Content: length bytes]\n   * Returns: { type, content } where content is the message body without type/length\n   */\n  async readFramedMessage() {\n    while (this.readBuffer.length < 3) {\n      const { value, done } = await this.reader.read();\n      if (done) {\n        throw new Error("Control stream closed unexpectedly");\n      }\n      const newBuffer = new Uint8Array(this.readBuffer.length + value.length);\n      newBuffer.set(this.readBuffer);\n      newBuffer.set(value, this.readBuffer.length);\n      this.readBuffer = newBuffer;\n    }\n    let typeLength = 1;\n    const firstByte = this.readBuffer[0];\n    const prefix = firstByte >> 6;\n    if (prefix === 1) typeLength = 2;\n    else if (prefix === 2) typeLength = 4;\n    else if (prefix === 3) typeLength = 8;\n    const headerSize = typeLength + 2;\n    while (this.readBuffer.length < headerSize) {\n      const { value, done } = await this.reader.read();\n      if (done) {\n        throw new Error("Control stream closed unexpectedly");\n      }\n      const newBuffer = new Uint8Array(this.readBuffer.length + value.length);\n      newBuffer.set(this.readBuffer);\n      newBuffer.set(value, this.readBuffer.length);\n      this.readBuffer = newBuffer;\n    }\n    let type;\n    if (typeLength === 1) {\n      type = firstByte;\n    } else if (typeLength === 2) {\n      type = (firstByte & 63) << 8 | this.readBuffer[1];\n    } else {\n      throw new Error(`Unsupported varint length: ${typeLength}`);\n    }\n    const lengthOffset = typeLength;\n    const contentLength = this.readBuffer[lengthOffset] << 8 | this.readBuffer[lengthOffset + 1];\n    this.log("readFramedMessage: type=0x" + type.toString(16) + ", contentLength=" + contentLength);\n    const totalSize = headerSize + contentLength;\n    while (this.readBuffer.length < totalSize) {\n      const { value, done } = await this.reader.read();\n      if (done) {\n        throw new Error("Control stream closed unexpectedly");\n      }\n      const newBuffer = new Uint8Array(this.readBuffer.length + value.length);\n      newBuffer.set(this.readBuffer);\n      newBuffer.set(value, this.readBuffer.length);\n      this.readBuffer = newBuffer;\n    }\n    const content = this.readBuffer.slice(headerSize, totalSize);\n    this.readBuffer = this.readBuffer.slice(totalSize);\n    this.log("readFramedMessage: returning type=0x" + type.toString(16) + ", content.length=" + content.length);\n    return { type, content };\n  }\n}\nconst SUBGROUP_TYPE_LOW = 16;\nconst SUBGROUP_TYPE_HIGH = 29;\nconst DEFAULT_PRIORITY_BIT = 32;\nconst STREAM_TYPE_SUBGROUP_SID_EXT = 21;\nfunction typeInfo(low) {\n  return {\n    explicitSid: low === 20 || low === 21 || low === 28 || low === 29,\n    sidIsFirstObject: low === 18 || low === 19 || low === 26 || low === 27,\n    ext: (low & 1) !== 0\n  };\n}\nasync function readSubgroupStream(readable, onHeader, onObject) {\n  const reader = readable.getReader();\n  let buf = new Uint8Array(0);\n  let done = false;\n  const fill = async (need) => {\n    while (buf.length < need && !done) {\n      const r = await reader.read();\n      if (r.done) {\n        done = true;\n        break;\n      }\n      const next = new Uint8Array(buf.length + r.value.length);\n      next.set(buf, 0);\n      next.set(r.value, buf.length);\n      buf = next;\n    }\n    return buf.length >= need;\n  };\n  const readVarint = async () => {\n    if (!await fill(1)) return null;\n    const width = 1 << (buf[0] >> 6);\n    if (!await fill(width)) return null;\n    const { value, bytesRead } = decodeVarint(buf, 0);\n    buf = buf.subarray(bytesRead);\n    return value;\n  };\n  const readByte = async () => {\n    if (!await fill(1)) return null;\n    const b = buf[0];\n    buf = buf.subarray(1);\n    return b;\n  };\n  const readBytes = async (n) => {\n    if (!await fill(n)) return null;\n    const out = buf.subarray(0, n);\n    buf = buf.subarray(n);\n    return out;\n  };\n  try {\n    const typeV = await readVarint();\n    if (typeV === null) return;\n    const type = Number(typeV);\n    const low = type & ~DEFAULT_PRIORITY_BIT;\n    if (low < SUBGROUP_TYPE_LOW || low > SUBGROUP_TYPE_HIGH || (low & 6) === 6) {\n      throw new Error(`not a subgroup stream (type 0x${type.toString(16)})`);\n    }\n    const info = typeInfo(low);\n    const trackAlias = Number(await readVarint());\n    const groupId = await readVarint();\n    let subgroupId = 0n;\n    if (info.explicitSid) {\n      subgroupId = await readVarint();\n    }\n    let priority = 0;\n    if ((type & DEFAULT_PRIORITY_BIT) === 0) {\n      priority = await readByte();\n    }\n    const header = {\n      trackAlias,\n      groupId,\n      subgroupId,\n      publisherPriority: priority,\n      endOfGroup: low >= 24\n    };\n    let first = true;\n    let prevId = 0n;\n    onHeader(header);\n    for (; ; ) {\n      const delta = await readVarint();\n      if (delta === null) return;\n      const objectId = first ? delta : prevId + delta + 1n;\n      if (first && info.sidIsFirstObject) {\n        header.subgroupId = objectId;\n      }\n      first = false;\n      prevId = objectId;\n      if (info.ext) {\n        const extLen = await readVarint();\n        if (extLen > 0n && await readBytes(Number(extLen)) === null) {\n          throw new Error("truncated extension headers");\n        }\n      }\n      const plen = Number(await readVarint());\n      if (plen === 0) {\n        await readVarint();\n        onObject(header, { objectId, payload: new Uint8Array(0) });\n        continue;\n      }\n      const payload = await readBytes(plen);\n      if (payload === null) throw new Error("truncated object payload");\n      onObject(header, { objectId, payload: new Uint8Array(payload) });\n    }\n  } catch (e) {\n    await reader.cancel(e).catch(() => {\n    });\n    throw e;\n  } finally {\n    reader.releaseLock();\n  }\n}\nclass SubgroupWriter {\n  constructor(writable, trackAlias, groupId = 0n, subgroupId = 0n, priority = 0) {\n    this.trackAlias = trackAlias;\n    this.groupId = groupId;\n    this.subgroupId = subgroupId;\n    this.priority = priority;\n    this.writer = writable.getWriter();\n  }\n  writer;\n  headerSent = false;\n  objectCount = 0n;\n  prevObjectId = 0n;\n  concat(parts) {\n    let n = 0;\n    for (const p of parts) n += p.length;\n    const out = new Uint8Array(n);\n    let o = 0;\n    for (const p of parts) {\n      out.set(p, o);\n      o += p.length;\n    }\n    return out;\n  }\n  async writeObject(objectId, payload) {\n    const parts = [];\n    if (!this.headerSent) {\n      parts.push(\n        encodeVarint(STREAM_TYPE_SUBGROUP_SID_EXT),\n        encodeVarint(this.trackAlias),\n        encodeVarint(this.groupId),\n        encodeVarint(this.subgroupId),\n        new Uint8Array([this.priority])\n      );\n      this.headerSent = true;\n    }\n    const delta = this.objectCount === 0n ? objectId : objectId - this.prevObjectId - 1n;\n    this.prevObjectId = objectId;\n    this.objectCount++;\n    parts.push(\n      encodeVarint(delta),\n      encodeVarint(0),\n      // no extension headers\n      encodeVarint(payload.length),\n      payload\n    );\n    await this.writer.write(this.concat(parts));\n  }\n  async close() {\n    await this.writer.close();\n  }\n}\nconst SETUP_PARAM_CONNECTION_CONFIG = 107937;\nconst textEncoder = new TextEncoder();\nfunction connectionConfigParam(cfg) {\n  const json = { client_id: cfg.clientId };\n  if (cfg.ticket !== void 0 && cfg.ticket !== "") {\n    json["ticket"] = cfg.ticket;\n  }\n  if (cfg.entities !== void 0) {\n    json["entities"] = cfg.entities;\n  }\n  if (cfg.setups !== void 0) {\n    json["setups"] = cfg.setups;\n  }\n  return {\n    type: SETUP_PARAM_CONNECTION_CONFIG,\n    value: textEncoder.encode(JSON.stringify(json))\n  };\n}\nclass MalformedError extends Error {\n}\nclass UnknownFlagsError extends Error {\n}\nconst FLAG_POSE = 1 << 0;\nconst FLAG_AUDIO = 1 << 1;\nconst FLAG_REDUNDANCY = 1 << 2;\nconst OFFSET_SHIFT = 3;\nconst OFFSET_BITS = 7 << OFFSET_SHIFT;\nconst FLAG_TS = 1 << 6;\nconst FLAG_RESERVED = 1 << 7;\nconst POSE_SIZE = 18;\nfunction roundHalfAway(v) {\n  return v < 0 ? -Math.round(-v) : Math.round(v);\n}\nfunction quantizeAngle(a) {\n  let q = roundHalfAway(a * 32767 / Math.PI);\n  if (q > 32767) q = 32767;\n  if (q < -32767) q = -32767;\n  return q;\n}\nfunction encodePoseInto(view, offset, p) {\n  view.setFloat32(offset, p.x, true);\n  view.setFloat32(offset + 4, p.y, true);\n  view.setFloat32(offset + 8, p.z, true);\n  view.setInt16(offset + 12, quantizeAngle(p.yaw), true);\n  view.setInt16(offset + 14, quantizeAngle(p.pitch), true);\n  view.setInt16(offset + 16, quantizeAngle(p.roll), true);\n  return offset + POSE_SIZE;\n}\nfunction encodeMonoObjectInto(out, p) {\n  let flags = 0;\n  if (p.pose) flags |= FLAG_POSE;\n  if (p.audio) {\n    if (p.audio.length === 0) throw new MalformedError("empty audio payload");\n    flags |= FLAG_AUDIO;\n  }\n  if (p.redundancy) {\n    if (!p.audio) throw new MalformedError("redundancy requires an audio-bearing packet");\n    if (p.redundancy.offset < 1 || p.redundancy.offset > 7) {\n      throw new MalformedError(`redundancy offset ${p.redundancy.offset} outside 1-7`);\n    }\n    if (p.redundancy.audio.length === 0) throw new MalformedError("empty redundancy payload");\n    flags |= FLAG_REDUNDANCY | p.redundancy.offset << OFFSET_SHIFT;\n  }\n  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);\n  let o = 0;\n  out[o++] = flags;\n  if (p.pose) {\n    o = encodePoseInto(view, o, p.pose);\n  }\n  if (p.audio) {\n    if (p.redundancy) {\n      view.setUint16(o, p.audio.length, true);\n      o += 2;\n    }\n    out.set(p.audio, o);\n    o += p.audio.length;\n    if (p.redundancy) {\n      out.set(p.redundancy.audio, o);\n      o += p.redundancy.audio.length;\n    }\n  }\n  return o;\n}\nfunction parseSink(data) {\n  if (data.length === 0) throw new MalformedError("empty packet");\n  const flags = data[0];\n  if ((flags & (FLAG_POSE | FLAG_AUDIO | FLAG_RESERVED)) !== 0) throw new UnknownFlagsError("sink");\n  if ((flags & FLAG_REDUNDANCY) === 0 && (flags & OFFSET_BITS) !== 0) {\n    throw new UnknownFlagsError("sink offset bits");\n  }\n  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);\n  let o = 1;\n  let ts;\n  if ((flags & FLAG_TS) !== 0) {\n    if (data.length - o < 8) throw new MalformedError("truncated timestamp");\n    ts = view.getBigUint64(o, true);\n    o += 8;\n  }\n  if ((flags & FLAG_REDUNDANCY) !== 0) {\n    if (data.length - o < 2) throw new MalformedError("truncated audio length");\n    const alen = view.getUint16(o, true);\n    o += 2;\n    if (data.length - o < alen) throw new MalformedError("truncated audio");\n    const audio2 = data.subarray(o, o + alen);\n    if (audio2.length === 0) throw new MalformedError("sink packets always carry audio");\n    o += alen;\n    const red = data.subarray(o);\n    if (red.length === 0) throw new MalformedError("empty redundancy payload");\n    return {\n      timestampMicros: ts,\n      audio: audio2,\n      redundancy: { offset: (flags & OFFSET_BITS) >> OFFSET_SHIFT, audio: red }\n    };\n  }\n  const audio = data.subarray(o);\n  if (audio.length === 0) throw new MalformedError("sink packets always carry audio");\n  return { timestampMicros: ts, audio };\n}\nnew TextDecoder();\nconst HISTORY = 8;\nfunction clampOffset(n) {\n  if (!Number.isFinite(n) || n <= 0) return 0;\n  return Math.min(7, Math.floor(n));\n}\nclass UplinkSequencer {\n  seq = 0n;\n  offset;\n  hist = [];\n  /** Reused record handed out on the packet (aliases the ring). */\n  red;\n  /**\n   * @param redundancy the offset (0 = off; above 7, the wire maximum,\n   *   clamps to 7).\n   * @param maxPayloadBytes initial ring slot size (grown on demand).\n   */\n  constructor(redundancy = 0, maxPayloadBytes = 4e3) {\n    this.offset = clampOffset(redundancy);\n    for (let i = 0; i < HISTORY; i++) {\n      this.hist.push({ seq: 0n, valid: false, len: 0, buf: new Uint8Array(maxPayloadBytes) });\n    }\n    this.red = { offset: this.offset, audio: new Uint8Array(0) };\n  }\n  /** The uplink redundancy offset in force (0 = none). */\n  get redundancy() {\n    return this.offset;\n  }\n  /** Changes the offset. Bounding it to the declaration is the caller\'s job. */\n  setRedundancy(offset) {\n    this.offset = clampOffset(offset);\n  }\n  /** The seq the next packet will get (diagnostics). */\n  get nextSeq() {\n    return this.seq;\n  }\n  /**\n   * Stamps `pkt` with the next seq: records its audio (a copy — the\n   * caller\'s buffer is reused) and, when the packet `offset` ago was\n   * audio-bearing and this one is too, attaches a repeat of it. Any\n   * `redundancy` the caller set is replaced when the offset is above\n   * 0; at offset 0 the packet passes through as given. The attached\n   * record aliases the ring and is valid until the next call: encode\n   * before calling again. Returns the seq (the datagram group id).\n   */\n  next(pkt) {\n    const seq = this.seq++;\n    this.attach(seq, pkt);\n    return seq;\n  }\n  attach(seq, pkt) {\n    if (this.offset === 0) return;\n    delete pkt.redundancy;\n    const slot = this.hist[Number(seq % BigInt(HISTORY))];\n    slot.seq = seq;\n    slot.valid = true;\n    const audio = pkt.audio;\n    if (!audio || audio.length === 0) {\n      slot.len = 0;\n      return;\n    }\n    if (audio.length > slot.buf.length) slot.buf = new Uint8Array(audio.length);\n    slot.buf.set(audio);\n    slot.len = audio.length;\n    const offset = BigInt(this.offset);\n    if (seq < offset) return;\n    const refSeq = seq - offset;\n    const ref = this.hist[Number(refSeq % BigInt(HISTORY))];\n    if (!ref.valid || ref.seq !== refSeq || ref.len === 0) return;\n    this.red.offset = this.offset;\n    this.red.audio = ref.buf.subarray(0, ref.len);\n    pkt.redundancy = this.red;\n  }\n}\nconst REASM_SKIP_THRESHOLD = 8;\nclass SinkReassembler {\n  lag;\n  skip;\n  started = false;\n  next = 0n;\n  // next seq to release\n  high = 0n;\n  // highest seq seen\n  held = /* @__PURE__ */ new Map();\n  /** Counters, cumulative for the instance (stats surface). */\n  delivered = 0;\n  // frames released with audio (repaired included)\n  repaired = 0;\n  // released from a redundant copy\n  concealed = 0;\n  // null-audio frames released at give-up\n  skipped = 0;\n  // dead frames skipped (freeze-sized holes)\n  stale = 0;\n  // packets dropped for arriving behind the release point\n  out = [];\n  constructor(lag) {\n    this.lag = BigInt(lag);\n    this.skip = BigInt(REASM_SKIP_THRESHOLD);\n  }\n  /**\n   * Accepts the packet with MoQ group-id seq, its primary audio payload,\n   * and its redundant copy (redOffset 0 / redAudio null when absent).\n   * Returns the frames released in order; the array is reused and valid\n   * until the next push. Held payloads are copied (the caller\'s buffer\n   * is not retained); the in-order fast path aliases the input.\n   */\n  push(seq, audio, redOffset, redAudio) {\n    this.out.length = 0;\n    if (!this.started) {\n      this.started = true;\n      this.next = seq;\n      this.high = seq;\n    }\n    if (seq < this.next) {\n      this.stale++;\n      return this.out;\n    }\n    if (seq > this.high) this.high = seq;\n    if (seq === this.next && this.held.size === 0) {\n      this.next++;\n      this.delivered++;\n      this.out.push({ seq, audio });\n      return this.out;\n    }\n    if (!this.held.has(seq)) {\n      this.held.set(seq, { audio: audio.slice(), repaired: false });\n    }\n    if (redAudio !== null && redOffset > 0 && seq >= BigInt(redOffset)) {\n      const r = seq - BigInt(redOffset);\n      if (r >= this.next && !this.held.has(r)) {\n        this.held.set(r, { audio: redAudio.slice(), repaired: true });\n      }\n    }\n    this.drain();\n    return this.out;\n  }\n  /**\n   * Releases from the head of the queue: held frames flush in order; a\n   * missing head frame past its give-up deadline is concealed, or the\n   * whole currently-dead run is skipped when it exceeds the freeze\n   * threshold.\n   */\n  drain() {\n    for (; ; ) {\n      const h = this.held.get(this.next);\n      if (h !== void 0) {\n        this.held.delete(this.next);\n        this.out.push({ seq: this.next, audio: h.audio });\n        this.delivered++;\n        if (h.repaired) this.repaired++;\n        this.next++;\n        continue;\n      }\n      if (this.high < this.next + this.lag + 2n) {\n        return;\n      }\n      let run = 1n;\n      for (; ; ) {\n        const s = this.next + run;\n        if (this.held.has(s)) break;\n        if (this.high < s + this.lag + 2n) break;\n        run++;\n      }\n      if (run > this.skip) {\n        this.next += run;\n        this.skipped += Number(run);\n        continue;\n      }\n      this.out.push({ seq: this.next, audio: null });\n      this.concealed++;\n      this.next++;\n    }\n  }\n}\nclass JitterBufferCore {\n  // ---- immutable geometry (frames) ----\n  capacity;\n  w;\n  r;\n  s;\n  nc;\n  sampleRate;\n  // ---- immutable derived tuning (Go: the ctor-derived block) ----\n  windowReads;\n  freezeReads;\n  narrowStep;\n  // frames per window (float; ÷κ)\n  spBase;\n  // max(R+S, R+W): the structural lattice floor\n  flDecl;\n  // declared floor; composes by MAX\n  kLow;\n  kHigh;\n  wlCap;\n  deadband;\n  gain;\n  rateCap;\n  ffClamp;\n  ffDeadZone;\n  theta;\n  spMax;\n  // ---- storage: capacity * nc interleaved floats ----\n  data;\n  // ---- SPSC heads — cumulative (never wrap). Index via (pos % capacity) * nc. ----\n  // writePos crosses the writer→reader thread boundary in SAB mode, so it is\n  // backed by an atomic cell when `sharedWritePos` is given; otherwise a plain\n  // number. The Atomics.store/load act as the release/acquire fence pairing\n  // the ring writes (writer) with the ring reads (reader) — the Go SPSC\n  // contract. readPos is reader-owned (the writer never touches it): plain.\n  _writePos = 0;\n  wpCell = null;\n  get writePos() {\n    return this.wpCell ? Number(Atomics.load(this.wpCell, 0)) : this._writePos;\n  }\n  set writePos(v) {\n    if (this.wpCell) Atomics.store(this.wpCell, 0, BigInt(v));\n    else this._writePos = v;\n  }\n  readPos = 0;\n  // ---- reader-owned sensing/controller state ----\n  started = false;\n  tick = 0;\n  // read count since start — the sensing clock\n  lastWp = 0;\n  gapRun = 0;\n  frozen = false;\n  // Current sensing window: pre-read raw fill + virtual signal, appended\n  // together (one shared count). Preallocated — no steady-state allocation\n  // on the audio thread.\n  rawBuf;\n  virtBuf;\n  sortBuf;\n  winCount = 0;\n  // Last K windows\' measured widths (rings) for the rank filter.\n  wlHist;\n  whHist;\n  histLen = 0;\n  histPos = 0;\n  // Feed-forward drift estimator: (tick, window-median virtual) pairs across\n  // the last K window closes. Reset on freeze-resume so an outage\'s virtual\n  // step never reads as drift.\n  ffTicks;\n  ffVals;\n  ffLen = 0;\n  // Held effective widths (frames, float), servo rate, debt, pending trim.\n  // Public for white-box tests and observability (v3 convention: outside\n  // write/read they are read-only; mutating by hand is a test seam only).\n  wl = 0;\n  wh = 0;\n  rate = 0;\n  // frames/s of read time; + = drop\n  debt = 0;\n  pendingTrim = 0;\n  /** Live setpoint (pre-read fill target, frames). Reader-written; observers read. */\n  setpoint;\n  // ---- cumulative stats (reader-owned plain numbers) ----\n  underruns = 0;\n  laps = 0;\n  overruns = 0;\n  trims = 0;\n  samplesDropped = 0;\n  samplesInserted = 0;\n  constructor(cfg = {}) {\n    const sr = cfg.sampleRate ?? 48e3;\n    const nc = cfg.numChannels ?? 1;\n    const f = (ms) => Math.trunc(ms * sr / 1e3);\n    const W = cfg.writerFrame ?? 0;\n    const R = cfg.readerFrame ?? 0;\n    if (W <= 0 || R <= 0) {\n      throw new Error("JitterBufferCore: readerFrame and writerFrame must be > 0 (the caller declares its geometry)");\n    }\n    const S = cfg.safety || f(1);\n    const level = cfg.qualityLevel ?? 0;\n    let qFloor = 0;\n    let qRob = 1;\n    let qCap = 0;\n    if (level === 1) {\n      qFloor = f(50);\n      qRob = 4;\n      qCap = f(500);\n    } else if (level >= 2) {\n      qFloor = f(150);\n      qRob = 8;\n      qCap = f(400);\n    }\n    const flDecl = Math.max(cfg.floor ?? 0, qFloor);\n    let kappa = cfg.robustness ?? qRob;\n    if (kappa < 1) kappa = 1;\n    const deadband = f(0.25);\n    const spBase = Math.max(R + S, R + W);\n    const kLow = 1.2 * kappa;\n    const kHigh = 1.5 * kappa;\n    const wlCap = Math.trunc(f(30) * kappa);\n    const whCap = Math.trunc(f(60) * kappa);\n    let spMax = Math.max(spBase + Math.trunc(kLow * wlCap), flDecl);\n    let ffDeadZone = Math.trunc(this.gcd(W, R) / 2);\n    if (ffDeadZone < 1) ffDeadZone = 1;\n    const theta = W + Math.trunc(20 * 2);\n    let capacity = cfg.capacity ?? qCap;\n    if (!capacity) {\n      capacity = 2 * (spMax + Math.trunc(kHigh * whCap)) + 2 * Math.max(W, R);\n    }\n    const reserve = 4 * Math.max(W, R);\n    if (spMax > capacity - reserve) {\n      spMax = Math.max(spBase, capacity - reserve);\n    }\n    this.capacity = capacity;\n    this.w = W;\n    this.r = R;\n    this.s = S;\n    this.nc = nc;\n    this.sampleRate = sr;\n    this.windowReads = Math.trunc(2 * sr / R);\n    this.freezeReads = Math.max(8, Math.trunc(f(40) / R));\n    this.narrowStep = f(0.5) / kappa;\n    this.spBase = spBase;\n    this.flDecl = flDecl;\n    this.kLow = kLow;\n    this.kHigh = kHigh;\n    this.wlCap = wlCap;\n    this.deadband = deadband;\n    this.gain = 0.01;\n    this.rateCap = 20;\n    this.ffClamp = 22;\n    this.ffDeadZone = ffDeadZone;\n    this.theta = theta;\n    this.spMax = spMax;\n    if (cfg.sharedStorage) {\n      if (cfg.sharedStorage.length !== capacity * nc) {\n        throw new Error(\n          `JitterBufferCore: sharedStorage length ${cfg.sharedStorage.length} != capacity*nc ${capacity * nc} (size it with computeJitterCapacity using the same config)`\n        );\n      }\n      this.data = cfg.sharedStorage;\n    } else {\n      this.data = new Float32Array(capacity * nc);\n    }\n    if (cfg.sharedWritePos) {\n      if (cfg.sharedWritePos.length < 1) {\n        throw new Error("JitterBufferCore: sharedWritePos must be a length-1 BigInt64Array");\n      }\n      this.wpCell = cfg.sharedWritePos;\n    }\n    this.rawBuf = new Float64Array(this.windowReads);\n    this.virtBuf = new Float64Array(this.windowReads);\n    this.sortBuf = new Float64Array(this.windowReads);\n    this.wlHist = new Float64Array(10);\n    this.whHist = new Float64Array(10);\n    this.ffTicks = new Float64Array(10);\n    this.ffVals = new Float64Array(10);\n    this.setpoint = Math.min(Math.max(spBase, flDecl), spMax);\n  }\n  /**\n   * Copy `src` (interleaved, length a multiple of `nc`) into the ring. Never\n   * blocks; writes larger than capacity are clipped to the most-recent\n   * frames. Identical to v3 (and to Go `Write`).\n   */\n  write(src) {\n    let nFrames = Math.floor(src.length / this.nc);\n    if (nFrames === 0) return;\n    if (nFrames > this.capacity) {\n      const skip = nFrames - this.capacity;\n      src = src.subarray(skip * this.nc);\n      nFrames = this.capacity;\n    }\n    const wp = this.writePos;\n    this.writeToRing(src, wp, nFrames);\n    this.writePos = wp + nFrames;\n  }\n  /**\n   * Copy up to `dst.length` interleaved samples from the ring, returning\n   * true when audio was produced. Order per read (Go `Read`): startup gate →\n   * pending macro-trim → capacity valves → sense → underrun valve → play\n   * with debt-bucket splice.\n   */\n  read(dst) {\n    const nc = this.nc;\n    const nFrames = Math.floor(dst.length / nc);\n    if (nFrames === 0) return true;\n    const wp = this.writePos;\n    let rp = this.readPos;\n    const sp = this.setpoint;\n    if (rp === 0) {\n      if (wp < sp) {\n        dst.fill(0);\n        return false;\n      }\n      rp = wp - sp;\n      this.readPos = rp;\n      this.started = true;\n      this.lastWp = wp;\n    }\n    if (this.pendingTrim > 0) {\n      const t = Math.min(this.pendingTrim, wp - rp - sp);\n      if (t > 0) {\n        rp += t;\n        this.readPos = rp;\n        this.trims++;\n      }\n      this.pendingTrim = 0;\n      this.resetWindow();\n    }\n    let fill = wp - rp;\n    if (fill >= this.capacity) {\n      rp = wp - sp;\n      this.readPos = rp;\n      fill = sp;\n      this.laps++;\n      this.resetWindow();\n    } else if (fill > this.capacity - (this.w + this.r)) {\n      rp = wp - sp;\n      this.readPos = rp;\n      fill = sp;\n      this.overruns++;\n      this.resetWindow();\n    }\n    this.sense(wp, fill);\n    if (fill < nFrames) {\n      dst.fill(0);\n      this.underruns++;\n      return false;\n    }\n    if (!this.frozen) {\n      this.debt += this.rate * this.r / this.sampleRate;\n      if (this.debt > 1.5) this.debt = 1.5;\n      else if (this.debt < -1.5) this.debt = -1.5;\n    }\n    if (this.debt >= 1 && fill >= nFrames + 1) {\n      this.debt--;\n      this.spliceDrop(dst, rp, nFrames);\n      this.readPos = rp + nFrames + 1;\n      this.samplesDropped++;\n    } else if (this.debt <= -1 && nFrames >= 2) {\n      this.debt++;\n      this.spliceInsert(dst, rp, nFrames);\n      this.readPos = rp + nFrames - 1;\n      this.samplesInserted++;\n    } else {\n      this.readFromRing(dst, rp, nFrames);\n      this.readPos = rp + nFrames;\n    }\n    return true;\n  }\n  /**\n   * Feed one pre-read observation into the sensing window and run the\n   * freeze/excise rule (design §3): a no-delivery run longer than\n   * `freezeReads` freezes sensing and the servo, and retroactively rewinds\n   * the run\'s own dip samples out of the window — outage, loss bursts and\n   * device stalls teach the estimator nothing. Short dips (a late packet, a\n   * lost packet) stay in: they are lateness evidence.\n   */\n  sense(wp, fill) {\n    if (!this.started) return;\n    const tick = this.tick;\n    this.tick++;\n    const delta = wp - this.lastWp;\n    this.lastWp = wp;\n    if (delta > 0) {\n      if (this.frozen) {\n        this.frozen = false;\n        this.resetWindow();\n        this.ffLen = 0;\n      }\n      this.gapRun = 0;\n    } else {\n      this.gapRun++;\n      if (!this.frozen && this.gapRun > this.freezeReads) {\n        this.frozen = true;\n        this.rate = 0;\n        this.debt = 0;\n        const rw = Math.min(this.gapRun - 1, this.winCount);\n        this.winCount -= rw;\n      }\n    }\n    if (this.frozen) return;\n    this.rawBuf[this.winCount] = fill;\n    this.virtBuf[this.winCount] = wp - this.r * tick;\n    this.winCount++;\n    if (this.winCount >= this.windowReads) {\n      this.closeWindow();\n    }\n  }\n  /**\n   * Compute the window estimates, update the width hold, the FF drift\n   * estimate and the setpoint, then run the shipped control law (Go\n   * `closeWindow` + `PServo.Decide`, inlined — the TS build is monomorphic;\n   * the Go Controller seam is test scaffolding the port does not need).\n   */\n  closeWindow() {\n    const n = this.winCount;\n    let s = this.sortBuf.subarray(0, n);\n    s.set(this.rawBuf.subarray(0, n));\n    s.sort();\n    const medRaw = s[n >> 1];\n    const minRaw = s[0];\n    s = this.sortBuf.subarray(0, n);\n    s.set(this.virtBuf.subarray(0, n));\n    s.sort();\n    const medV = s[n >> 1];\n    const minV = s[0];\n    const maxV = s[n - 1];\n    const wlMeas = Math.min(medV - minV, this.wlCap);\n    const whMeas = maxV - medV;\n    this.wlHist[this.histPos] = wlMeas;\n    this.whHist[this.histPos] = whMeas;\n    this.histPos = (this.histPos + 1) % 10;\n    if (this.histLen < 10) this.histLen++;\n    const wlEff = this.rankNth(this.wlHist, this.histLen, 3);\n    const whEff = this.rankNth(this.whHist, this.histLen, 3);\n    this.wl = Math.max(wlEff, this.wl - this.narrowStep);\n    this.wh = Math.max(whEff, this.wh - this.narrowStep);\n    if (this.ffLen >= 10) {\n      this.ffTicks.copyWithin(0, 1);\n      this.ffVals.copyWithin(0, 1);\n      this.ffLen = 9;\n    }\n    this.ffTicks[this.ffLen] = this.tick;\n    this.ffVals[this.ffLen] = medV;\n    this.ffLen++;\n    let slope = 0;\n    const fn = this.ffLen;\n    if (fn >= 2 && this.ffTicks[fn - 1] > this.ffTicks[0]) {\n      let lo = this.ffVals[0];\n      let hi = this.ffVals[fn - 1];\n      let ta = this.ffTicks[0];\n      let tb = this.ffTicks[fn - 1];\n      if (fn >= 6) {\n        lo = this.median3(this.ffVals[0], this.ffVals[1], this.ffVals[2]);\n        hi = this.median3(this.ffVals[fn - 3], this.ffVals[fn - 2], this.ffVals[fn - 1]);\n        ta = this.ffTicks[1];\n        tb = this.ffTicks[fn - 2];\n      }\n      const span = tb - ta;\n      if (span > 0) {\n        const perRead = (hi - lo) / span;\n        const d = perRead * span;\n        if (d >= this.ffDeadZone || d <= -this.ffDeadZone) {\n          slope = perRead * this.sampleRate / this.r;\n        }\n      }\n    }\n    const dbEff = Math.max(this.deadband, Math.trunc(this.wl));\n    const sp = Math.min(Math.max(this.spBase + Math.trunc(this.kLow * this.wl + 0.5), this.flDecl), this.spMax);\n    this.setpoint = sp;\n    let rate = 0;\n    let trim = 0;\n    if (minRaw - sp > this.theta) {\n      trim = medRaw - sp;\n    } else {\n      let ff = slope;\n      if (ff > this.ffClamp || ff < -this.ffClamp) {\n        ff = this.ffClamp * this.ffClamp / ff;\n      }\n      let p = 0;\n      const e = medRaw - sp;\n      if (e > dbEff) {\n        p = this.gain * (e - dbEff);\n      }\n      rate = p + ff;\n      if (rate > this.rateCap) rate = this.rateCap;\n      else if (rate < -this.rateCap) rate = -this.rateCap;\n    }\n    this.rate = rate;\n    if (trim > 0) this.pendingTrim = trim;\n    this.resetWindow();\n  }\n  resetWindow() {\n    this.winCount = 0;\n  }\n  /**\n   * The n-th highest of the first `len` values — the width recurrence\n   * filter (Go `rankNth`). Short histories use their lowest value (a width\n   * is only believed once seen n times).\n   */\n  rankNth(h, len, n) {\n    if (len < n) n = len;\n    const top = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];\n    for (let k = 0; k < len; k++) {\n      const v = h[k];\n      for (let i = 0; i < n; i++) {\n        if (v > top[i]) {\n          for (let j = n - 1; j > i; j--) top[j] = top[j - 1];\n          top[i] = v;\n          break;\n        }\n      }\n    }\n    return top[n - 1];\n  }\n  /** Median of three values (Go `median3`). */\n  median3(a, b, c) {\n    if (a > b) {\n      const t = a;\n      a = b;\n      b = t;\n    }\n    if (b > c) b = c;\n    return a > b ? a : b;\n  }\n  /** Greatest common divisor of two positive values (Go `gcd`). */\n  gcd(a, b) {\n    while (b !== 0) {\n      const t = a % b;\n      a = b;\n      b = t;\n    }\n    return a;\n  }\n  /**\n   * Consume nFrames+1 ring frames into an nFrames output with one frame\n   * removed at the grade-1 cut: the adjacent consumed pair with the minimum\n   * summed per-channel discontinuity, averaged into a single boundary frame\n   * (the decoder\'s drop marker, at any in-block position). Go `spliceDrop`.\n   */\n  spliceDrop(dst, rp, nFrames) {\n    const nc = this.nc;\n    const cap = this.capacity;\n    let cut = 0;\n    let best = -1;\n    for (let i = 0; i < nFrames; i++) {\n      const d = this.frameDiff(rp + i, rp + i + 1);\n      if (best < 0 || d <= best) {\n        best = d;\n        cut = i;\n      }\n    }\n    for (let j = 0; j < nFrames; j++) {\n      let src = rp + j;\n      if (j > cut) src++;\n      const sb = src % cap * nc;\n      const db = j * nc;\n      if (j === cut) {\n        const nb = (src + 1) % cap * nc;\n        for (let ch = 0; ch < nc; ch++) {\n          dst[db + ch] = Math.fround(this.data[sb + ch] + this.data[nb + ch]) * 0.5;\n        }\n        continue;\n      }\n      for (let ch = 0; ch < nc; ch++) dst[db + ch] = this.data[sb + ch];\n    }\n  }\n  /**\n   * Consume nFrames−1 ring frames into an nFrames output with one synthetic\n   * frame added at the grade-1 cut: the average of the adjacent pair around\n   * it (the decoder\'s insert marker). Go `spliceInsert`.\n   */\n  spliceInsert(dst, rp, nFrames) {\n    const nc = this.nc;\n    const cap = this.capacity;\n    let cut = 1;\n    let best = -1;\n    for (let i = 1; i < nFrames; i++) {\n      const d = this.frameDiff(rp + i - 1, rp + i);\n      if (best < 0 || d <= best) {\n        best = d;\n        cut = i;\n      }\n    }\n    for (let j = 0; j < nFrames; j++) {\n      let src = rp + j;\n      if (j > cut) src--;\n      const db = j * nc;\n      if (j === cut) {\n        const ab = (rp + cut - 1) % cap * nc;\n        const bb = (rp + cut) % cap * nc;\n        for (let ch = 0; ch < nc; ch++) {\n          dst[db + ch] = Math.fround(this.data[ab + ch] + this.data[bb + ch]) * 0.5;\n        }\n        continue;\n      }\n      const sb = src % cap * nc;\n      for (let ch = 0; ch < nc; ch++) dst[db + ch] = this.data[sb + ch];\n    }\n  }\n  /**\n   * Summed per-channel discontinuity between two frames, in float32\n   * arithmetic (`Math.fround` mirrors Go\'s float32 ops so the placement\n   * scan picks the identical cut — the fixture replay depends on it).\n   */\n  frameDiff(p, q) {\n    const nc = this.nc;\n    const cap = this.capacity;\n    const pb = p % cap * nc;\n    const qb = q % cap * nc;\n    let d = 0;\n    for (let ch = 0; ch < nc; ch++) {\n      let x = Math.fround(this.data[pb + ch] - this.data[qb + ch]);\n      if (x < 0) x = -x;\n      d = Math.fround(d + x);\n    }\n    return d;\n  }\n  /** Current fill in frames. */\n  fillFrames() {\n    return this.writePos - this.readPos;\n  }\n  /** Fill in interleaved floats (matching the Go ICircularBuffer convention). */\n  getBehind() {\n    return this.fillFrames() * this.nc;\n  }\n  /** Rich snapshot for tuning/observability (Go `Snapshot`). */\n  snapshot() {\n    const srMs = this.sampleRate / 1e3;\n    const fill = this.fillFrames();\n    const wl = Math.trunc(this.wl);\n    const wh = Math.trunc(this.wh);\n    return {\n      fillFrames: fill,\n      fillMs: fill / srMs,\n      setpointFrames: this.setpoint,\n      setpointMs: this.setpoint / srMs,\n      widthLowFrames: wl,\n      widthLowMs: wl / srMs,\n      widthHighFrames: wh,\n      widthHighMs: wh / srMs,\n      ratePerSec: this.rate,\n      frozen: this.frozen,\n      started: this.readPos > 0,\n      underruns: this.underruns,\n      overruns: this.overruns,\n      laps: this.laps,\n      trims: this.trims,\n      samplesDropped: this.samplesDropped,\n      samplesInserted: this.samplesInserted\n    };\n  }\n  /**\n   * Copy `nFrames` frames from `src` into the ring at frame position `wp`,\n   * handling wraparound. Caller guarantees `nFrames <= capacity`.\n   */\n  writeToRing(src, wp, nFrames) {\n    const cap = this.capacity;\n    const nc = this.nc;\n    const startFrame = wp % cap;\n    if (startFrame + nFrames <= cap) {\n      this.data.set(src.subarray(0, nFrames * nc), startFrame * nc);\n      return;\n    }\n    const first = cap - startFrame;\n    this.data.set(src.subarray(0, first * nc), startFrame * nc);\n    this.data.set(src.subarray(first * nc, nFrames * nc), 0);\n  }\n  /**\n   * Copy `nFrames` frames from the ring at frame position `rp` into `dst`,\n   * handling wraparound. Caller guarantees `nFrames <= capacity`.\n   */\n  readFromRing(dst, rp, nFrames) {\n    const cap = this.capacity;\n    const nc = this.nc;\n    const startFrame = rp % cap;\n    if (startFrame + nFrames <= cap) {\n      dst.set(this.data.subarray(startFrame * nc, (startFrame + nFrames) * nc));\n      return;\n    }\n    const first = cap - startFrame;\n    dst.set(this.data.subarray(startFrame * nc, cap * nc), 0);\n    dst.set(this.data.subarray(0, (nFrames - first) * nc), first * nc);\n  }\n}\nclass CaptureRing {\n  nc;\n  capacity;\n  data;\n  wpCell;\n  rpCell;\n  /** Count of quanta dropped because the consumer stalled past capacity (§5.1). */\n  overflows;\n  constructor(cfg) {\n    const nc = cfg.numChannels ?? 1;\n    const capacity = cfg.capacityFrames ?? 2048;\n    if (nc < 1) {\n      throw new Error("CaptureRing: numChannels must be >= 1");\n    }\n    if (capacity < 1) {\n      throw new Error("CaptureRing: capacityFrames must be >= 1");\n    }\n    if (cfg.sharedStorage.length !== capacity * nc) {\n      throw new Error(\n        `CaptureRing: sharedStorage length ${cfg.sharedStorage.length} != capacity*nc ${capacity * nc} (allocate capacityFrames * numChannels floats)`\n      );\n    }\n    if (cfg.sharedWritePos.length < 1 || cfg.sharedReadPos.length < 1) {\n      throw new Error("CaptureRing: sharedWritePos/sharedReadPos must be length-1 BigInt64Arrays");\n    }\n    this.nc = nc;\n    this.capacity = capacity;\n    this.data = cfg.sharedStorage;\n    this.wpCell = cfg.sharedWritePos;\n    this.rpCell = cfg.sharedReadPos;\n    this.overflows = 0;\n  }\n  /** Cumulative producer position (frames), acquire-loaded. */\n  get writePos() {\n    return Number(Atomics.load(this.wpCell, 0));\n  }\n  /** Cumulative consumer position (frames), acquire-loaded. */\n  get readPos() {\n    return Number(Atomics.load(this.rpCell, 0));\n  }\n  /** Current fill in frames (unambiguous: positions are cumulative). */\n  fillFrames() {\n    return this.writePos - this.readPos;\n  }\n  /**\n   * PRODUCER (capture worklet). Interleave one render quantum of planar channels into\n   * the ring. `planar[ch]` is a Float32Array of `nFrames` samples (Web Audio is\n   * planar; all channels equal length). Channels beyond `planar.length` reuse the last\n   * (mono→stereo dup); channels beyond `nc` are ignored. If the consumer has stalled\n   * and the quantum would not fit, the WHOLE quantum is dropped and `overflows` is\n   * bumped — never blocks, never overwrites unread data (§5.1). Returns true if written.\n   */\n  write(planar) {\n    if (!planar || planar.length === 0 || !planar[0]) {\n      return false;\n    }\n    const nc = this.nc;\n    const cap = this.capacity;\n    const nFrames = planar[0].length;\n    if (nFrames === 0) {\n      return false;\n    }\n    const wp = this.writePos;\n    const rp = this.readPos;\n    if (wp - rp + nFrames > cap) {\n      this.overflows++;\n      return false;\n    }\n    const data = this.data;\n    const startFrame = wp % cap;\n    for (let i = 0; i < nFrames; i++) {\n      const ringBase = (startFrame + i) % cap * nc;\n      for (let ch = 0; ch < nc; ch++) {\n        const src = planar[ch < planar.length ? ch : planar.length - 1];\n        data[ringBase + ch] = src[i];\n      }\n    }\n    Atomics.store(this.wpCell, 0, BigInt(wp + nFrames));\n    return true;\n  }\n  /**\n   * CONSUMER (MOQ worker). Copy all whole frames currently available into `dst`\n   * (interleaved), up to `dst`\'s capacity, then free that space. Returns the number of\n   * interleaved SAMPLES written (`frames * nc`), or 0 if nothing was ready. Drain to\n   * empty: leaves only what the producer hasn\'t yet published.\n   */\n  drain(dst) {\n    const nc = this.nc;\n    const cap = this.capacity;\n    const wp = this.writePos;\n    const rp = this.readPos;\n    const avail = wp - rp;\n    const room = Math.floor(dst.length / nc);\n    const nFrames = avail < room ? avail : room;\n    if (nFrames <= 0) {\n      return 0;\n    }\n    const data = this.data;\n    const startFrame = rp % cap;\n    if (startFrame + nFrames <= cap) {\n      dst.set(data.subarray(startFrame * nc, (startFrame + nFrames) * nc));\n    } else {\n      const first = cap - startFrame;\n      dst.set(data.subarray(startFrame * nc, cap * nc), 0);\n      dst.set(data.subarray(0, (nFrames - first) * nc), first * nc);\n    }\n    Atomics.store(this.rpCell, 0, BigInt(rp + nFrames));\n    return nFrames * nc;\n  }\n}\nclass CaptureEncoder {\n  ring;\n  trackAlias;\n  sampleRate;\n  nc;\n  priority;\n  poseCell;\n  sequencer;\n  encoder;\n  send;\n  // Reused scratch — the zero-alloc hot path.\n  pcmScratch;\n  // drained interleaved PCM\n  bytesScratch;\n  // Opus bytes (encoder output copyTo)\n  payloadScratch;\n  // framed MonoObjectPacket\n  dgPool;\n  // framed OBJECT_DATAGRAMs, round-robin\n  dgPoolIdx;\n  pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };\n  pkt = { pose: this.pose };\n  // Input timestamp is a running sample count; the datagram groupId is\n  // the gapless packet sequence (§5.2) from the sequencer, objectId 0.\n  samplesSent = 0;\n  // Observability.\n  encodedBatches = 0;\n  sentDatagrams = 0;\n  droppedOversize = 0;\n  constructor(cfg) {\n    this.ring = cfg.ring;\n    this.trackAlias = cfg.trackAlias;\n    this.sampleRate = cfg.sampleRate;\n    this.nc = cfg.numChannels;\n    this.priority = cfg.publisherPriority ?? 0;\n    this.poseCell = cfg.poseCell;\n    this.sequencer = cfg.sequencer;\n    this.send = cfg.send;\n    const maxPayload = cfg.maxPayloadBytes ?? 4e3;\n    this.pcmScratch = new Float32Array(cfg.ring.capacity * this.nc);\n    this.bytesScratch = new Uint8Array(maxPayload);\n    this.payloadScratch = new Uint8Array(2 * maxPayload + 64);\n    const poolSize = cfg.datagramPoolSize ?? 8;\n    this.dgPool = [];\n    for (let i = 0; i < poolSize; i++) {\n      this.dgPool.push(new Uint8Array(maxObjectDatagramSize(this.payloadScratch.length)));\n    }\n    this.dgPoolIdx = 0;\n    this.encoder = cfg.makeEncoder((chunk) => this.handleChunk(chunk));\n  }\n  /**\n   * Drain all PCM currently in the ring and feed it to the encoder as\n   * one batch. Returns the interleaved sample count encoded (0 if the\n   * ring was empty). Opus does the packetization internally.\n   */\n  pump() {\n    const n = this.ring.drain(this.pcmScratch);\n    if (n <= 0) {\n      return 0;\n    }\n    const frames = n / this.nc;\n    const timestampUs = Math.round(this.samplesSent / this.sampleRate * 1e6);\n    this.encoder.encode(this.pcmScratch.subarray(0, n), frames, timestampUs);\n    this.samplesSent += frames;\n    this.encodedBatches++;\n    return n;\n  }\n  /**\n   * Encoder output: stamp the FRESHEST pose, frame the mono-object\n   * packet, frame the datagram, send. No alloc.\n   */\n  handleChunk(chunk) {\n    const size = chunk.byteLength;\n    if (size === 0) {\n      return;\n    }\n    if (size > this.bytesScratch.length) {\n      this.droppedOversize++;\n      return;\n    }\n    chunk.copyTo(this.bytesScratch);\n    this.poseCell.read(this.pose);\n    this.pkt.audio = this.bytesScratch.subarray(0, size);\n    const seq = this.sequencer.next(this.pkt);\n    const payloadLen = encodeMonoObjectInto(this.payloadScratch, this.pkt);\n    const dg = this.dgPool[this.dgPoolIdx];\n    this.dgPoolIdx = (this.dgPoolIdx + 1) % this.dgPool.length;\n    const len = encodeObjectDatagramInto(\n      dg,\n      this.trackAlias,\n      seq,\n      // groupId = gapless packet sequence (§5.2)\n      0n,\n      this.priority,\n      this.payloadScratch.subarray(0, payloadLen)\n    );\n    this.send(dg.subarray(0, len));\n    this.sentDatagrams++;\n  }\n  /** Flush any buffered Opus packet (fires `handleChunk`) and close the encoder. */\n  async stop() {\n    try {\n      await this.encoder.flush();\n    } catch {\n    }\n    this.encoder.close();\n  }\n}\nclass PoseCell {\n  constructor(views) {\n    this.views = views;\n    if (views.seq.length < 1 || views.values.length < 6) {\n      throw new Error("PoseCell: seq must be length-1 Int32Array, values length-6 Float64Array");\n    }\n  }\n  /**\n   * WRITER (main). Publish a pose: odd the counter, write, even it.\n   * Single-writer — concurrent writers would corrupt the seqlock.\n   */\n  write(p) {\n    const { seq, values } = this.views;\n    Atomics.add(seq, 0, 1);\n    values[0] = p.x;\n    values[1] = p.y;\n    values[2] = p.z;\n    values[3] = p.yaw;\n    values[4] = p.pitch;\n    values[5] = p.roll;\n    Atomics.add(seq, 0, 1);\n  }\n  /**\n   * READER (worker). Copy the latest consistent snapshot into `out`.\n   * BOUNDED retry: the writer is the main thread, and if it is\n   * preempted mid-write the counter stays odd for the whole preemption\n   * — an unbounded retry loop would busy-spin the worker (stalling\n   * capture, encode, sends AND sink decode) until main resumes. That\n   * exact stall was observed live 2026-08-06 as accumulate-then-burst\n   * jitter churn while dragging poses. On retry exhaustion `out` is\n   * left UNTOUCHED: the caller reuses its previous snapshot, so the\n   * packet carries a pose one write staler — harmless under the\n   * freshest-wins design, and the next read catches up.\n   */\n  read(out) {\n    const { seq, values } = this.views;\n    for (let attempt = 0; attempt < 3; attempt++) {\n      const s1 = Atomics.load(seq, 0);\n      if ((s1 & 1) === 1) continue;\n      const x = values[0];\n      const y = values[1];\n      const z = values[2];\n      const yaw = values[3];\n      const pitch = values[4];\n      const roll = values[5];\n      if (Atomics.load(seq, 0) !== s1) continue;\n      out.x = x;\n      out.y = y;\n      out.z = z;\n      out.yaw = yaw;\n      out.pitch = pitch;\n      out.roll = roll;\n      return;\n    }\n  }\n}\nconst ctx = self;\nfunction post(m, transfer) {\n  ctx.postMessage(m, transfer);\n}\nlet conn = null;\nlet session = null;\nlet debug = false;\nlet lastCloseInfo = null;\nlet closePosted = false;\nlet stateSourceAlias = null;\nlet stateAliasWaiters = [];\nlet stateWriter = null;\nlet stateWriterPromise = null;\nlet stateObjId = 0n;\nconst entityAliases = /* @__PURE__ */ new Map();\nconst entityAliasWaiters = /* @__PURE__ */ new Map();\nfunction waitForEntityAlias(entityId, timeoutMs = 5e3) {\n  const existing = entityAliases.get(entityId);\n  if (existing !== void 0) return Promise.resolve(existing);\n  return new Promise((resolve, reject) => {\n    const timer = setTimeout(\n      () => reject(new Error(`server did not subscribe entity ${entityId} source in ${timeoutMs}ms`)),\n      timeoutMs\n    );\n    const list = entityAliasWaiters.get(entityId) ?? [];\n    list.push(() => {\n      clearTimeout(timer);\n      resolve(entityAliases.get(entityId));\n    });\n    entityAliasWaiters.set(entityId, list);\n  });\n}\nconst sources = /* @__PURE__ */ new Map();\nlet declaredRedundancy = /* @__PURE__ */ new Map();\nfunction sourceFor(entityId) {\n  let s = sources.get(entityId);\n  if (!s) {\n    s = new UplinkSequencer(declaredRedundancy.get(entityId) ?? 0);\n    sources.set(entityId, s);\n  }\n  return s;\n}\nconst publishPayload = new Uint8Array(2 * 4e3 + 64);\nconst publishDatagram = new Uint8Array(maxObjectDatagramSize(publishPayload.length));\nfunction handlePublish(cmd) {\n  if (!conn) return;\n  const alias = entityAliases.get(cmd.entityId);\n  if (alias === void 0) {\n    post({ type: "notice", event: "publish-dropped", detail: `${cmd.entityId}: source not subscribed yet` });\n    return;\n  }\n  const seq = sourceFor(cmd.entityId).next(cmd.packet);\n  const payloadLen = encodeMonoObjectInto(publishPayload, cmd.packet);\n  const n = encodeObjectDatagramInto(publishDatagram, alias, seq, 0n, 0, publishPayload.subarray(0, payloadLen));\n  conn.sendDatagram(publishDatagram.slice(0, n)).catch((err) => log("publish failed:", err));\n}\nconst captures = /* @__PURE__ */ new Map();\nconst capturesStarting = /* @__PURE__ */ new Set();\nconst sinkTracks = /* @__PURE__ */ new Map();\nlet copyPath = null;\nlet decodePcm = new Float32Array(0);\nlet planarScratch = new Float32Array(0);\nlet zeroPcm = new Float32Array(0);\nfunction copyDecoded(audioData, pcm, frames, channels) {\n  if (copyPath !== "f32-planar") {\n    try {\n      audioData.copyTo(pcm, { planeIndex: 0, format: "f32" });\n      copyPath = "f32";\n      return;\n    } catch {\n      copyPath = "f32-planar";\n    }\n  }\n  if (planarScratch.length < frames) planarScratch = new Float32Array(frames);\n  const plane = planarScratch.subarray(0, frames);\n  for (let ch = 0; ch < channels; ch++) {\n    audioData.copyTo(plane, { planeIndex: ch, format: "f32-planar" });\n    for (let i = 0; i < frames; i++) pcm[i * channels + ch] = plane[i];\n  }\n}\nfunction log(...args) {\n  if (debug) console.log("[moq-worker]", ...args);\n}\nfunction certHashOption(base64) {\n  if (!base64) return void 0;\n  const raw = atob(base64);\n  const bytes = new Uint8Array(raw.length);\n  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);\n  return [{ algorithm: "sha-256", value: bytes.buffer }];\n}\nasync function handleConnect(cmd) {\n  debug = cmd.debug;\n  lastCloseInfo = null;\n  closePosted = false;\n  conn = new MoqConnection(cmd.url, debug);\n  conn.setHandlers({\n    onClose: (info) => {\n      lastCloseInfo = { closeCode: info.closeCode, reason: info.reason };\n      if (!closePosted) {\n        closePosted = true;\n        post({ type: "transportClosed", closeCode: info.closeCode, reason: info.reason });\n      }\n    },\n    onStateChange: (state, error) => {\n      if (state === ConnectionState.ERROR && !closePosted) {\n        closePosted = true;\n        lastCloseInfo ??= { reason: String(error ?? "transport error") };\n        post({ type: "transportClosed", reason: String(error ?? "transport error") });\n      }\n    }\n  });\n  await conn.connect({\n    protocols: ["moqt-16"],\n    serverCertificateHashes: certHashOption(cmd.serverCertificateHashBase64)\n  });\n  session = new MoqSession(conn, debug);\n  declaredRedundancy = new Map((cmd.config.entities ?? []).map((e) => [e.id, e.redundancy ?? 0]));\n  session.onIncomingSubscribe((namespace, trackAlias) => {\n    if (namespace.length === 4 && namespace[1] === "client" && namespace[3] === "source") {\n      stateSourceAlias = trackAlias;\n      for (const w of stateAliasWaiters.splice(0)) w();\n    }\n    if (namespace.length === 4 && namespace[1] === "entity" && namespace[3] === "source") {\n      const entityId = namespace[2];\n      entityAliases.set(entityId, trackAlias);\n      const waiters = entityAliasWaiters.get(entityId);\n      if (waiters) {\n        entityAliasWaiters.delete(entityId);\n        for (const w of waiters) w();\n      }\n    }\n    post({ type: "incomingSubscribe", namespace, trackAlias });\n  });\n  await session.initialize(MoqRole.PUBSUB, void 0, 100, [connectionConfigParam(cmd.config)]);\n  session.startMessageLoop();\n  startDatagramLoop();\n  startSubgroupAcceptLoop();\n}\nfunction startDatagramLoop() {\n  const readable = conn.takeDatagramReadableForWorker();\n  if (!readable) throw new Error("no datagram readable (not connected)");\n  const reader = readable.getReader();\n  void (async () => {\n    try {\n      for (; ; ) {\n        const { value, done } = await reader.read();\n        if (done) {\n          post({ type: "notice", event: "datagram-reader-done" });\n          return;\n        }\n        if (!value) continue;\n        let parsed;\n        try {\n          parsed = parseObjectDatagram(value);\n        } catch {\n          continue;\n        }\n        const sink = sinkTracks.get(parsed.trackAlias);\n        if (sink) {\n          decodeSinkDatagram(parsed.trackAlias, sink, parsed.groupId, parsed.payload);\n          continue;\n        }\n        post(\n          {\n            type: "datagram",\n            trackAlias: parsed.trackAlias,\n            groupId: parsed.groupId,\n            objectId: parsed.objectId,\n            payload: parsed.payload\n          },\n          [value.buffer]\n        );\n      }\n    } catch (e) {\n      post({ type: "notice", event: "datagram-reader-error", detail: String(e) });\n    }\n  })();\n}\nfunction startSubgroupAcceptLoop() {\n  const transport = conn.getTransport();\n  void (async () => {\n    const streams = transport.incomingUnidirectionalStreams.getReader();\n    for (; ; ) {\n      const r = await streams.read().catch(() => ({ done: true, value: void 0 }));\n      if (r.done) {\n        post({ type: "notice", event: "subgroup-accept-done" });\n        return;\n      }\n      void readSubgroupStream(\n        r.value,\n        () => {\n        },\n        (h, o) => {\n          post(\n            {\n              type: "subgroupObject",\n              trackAlias: h.trackAlias,\n              groupId: h.groupId,\n              subgroupId: h.subgroupId,\n              objectId: o.objectId,\n              payload: o.payload\n            },\n            [o.payload.buffer]\n          );\n        }\n      ).catch((e) => {\n        post({ type: "notice", event: "subgroup-stream-error", detail: String(e) });\n      });\n    }\n  })();\n}\nasync function handleSubscribe(cmd) {\n  if (!session) throw new Error("not connected");\n  const subscribeId = await session.subscribe(\n    cmd.namespace,\n    cmd.trackName,\n    void 0,\n    void 0,\n    cmd.extraParams\n  );\n  const trackAlias = session.getTrackAlias(subscribeId);\n  if (trackAlias === void 0) throw new Error("no track alias after SUBSCRIBE_OK");\n  session.onPublishDone(subscribeId, (statusCode, reason) => {\n    post({ type: "publishDone", subscribeId, statusCode, reason });\n  });\n  post({ type: "subscribed", id: cmd.id, subscribeId, trackAlias });\n}\nfunction feedDecoder(trackAlias, sink, seq, data) {\n  if (sink.decoder.state !== "configured") {\n    sink.decodeErrors++;\n    return;\n  }\n  try {\n    sink.decoder.decode(\n      new EncodedAudioChunk({\n        type: "key",\n        // Opus frames are always key frames\n        timestamp: Number(seq) * sink.frameDurationUs,\n        data\n      })\n    );\n  } catch (e) {\n    sink.decodeErrors++;\n    post({ type: "notice", event: "decode-error", detail: `alias ${trackAlias}: ${String(e)}` });\n  }\n}\nfunction decodeSinkDatagram(trackAlias, sink, seq, payload) {\n  let pkt;\n  try {\n    pkt = parseSink(payload);\n  } catch {\n    return;\n  }\n  if (pkt.audio.length === 0) return;\n  sink.received++;\n  if (sink.lastSeq !== null) {\n    if (seq > sink.lastSeq + 1n) {\n      sink.gapEvents++;\n      sink.lostFrames += Number(seq - sink.lastSeq - 1n);\n    } else if (seq <= sink.lastSeq) {\n      sink.reordered++;\n    }\n  }\n  if (sink.lastSeq === null || seq > sink.lastSeq) sink.lastSeq = seq;\n  if (sink.reasm) {\n    const red = pkt.redundancy;\n    for (const e of sink.reasm.push(seq, pkt.audio, red?.offset ?? 0, red?.audio ?? null)) {\n      if (e.audio === null) {\n        sink.pendingConceal.push(e.seq);\n      } else {\n        feedDecoder(trackAlias, sink, e.seq, e.audio);\n      }\n    }\n    return;\n  }\n  feedDecoder(trackAlias, sink, seq, pkt.audio);\n}\nfunction handleSetSinkTrack(cmd) {\n  clearSinkTrack(cmd.trackAlias);\n  const jbuf = new JitterBufferCore({\n    ...cmd.jbufConfig,\n    sharedStorage: cmd.sharedStorage,\n    sharedWritePos: cmd.sharedWritePos\n  });\n  const track = {\n    jbuf,\n    frameDurationUs: cmd.decoderConfig.frameDurationUs,\n    formatKey: "",\n    reasm: (cmd.redundancy ?? 0) > 0 ? new SinkReassembler(cmd.redundancy) : null,\n    pendingConceal: [],\n    lastSeq: null,\n    received: 0,\n    gapEvents: 0,\n    lostFrames: 0,\n    reordered: 0,\n    decodeErrors: 0,\n    ingressTimer: setInterval(() => {\n      const t = sinkTracks.get(cmd.trackAlias);\n      if (!t) return;\n      post({\n        type: "sinkIngress",\n        trackAlias: cmd.trackAlias,\n        received: t.received,\n        gapEvents: t.gapEvents,\n        lostFrames: t.lostFrames,\n        reordered: t.reordered,\n        decodeErrors: t.decodeErrors,\n        fecRepaired: t.reasm?.repaired ?? 0,\n        fecConcealed: t.reasm?.concealed ?? 0,\n        fecSkipped: t.reasm?.skipped ?? 0\n      });\n    }, 2e3),\n    decoder: new AudioDecoder({\n      output: (audioData) => {\n        try {\n          const frames = audioData.numberOfFrames;\n          const channels = audioData.numberOfChannels;\n          const need = frames * channels;\n          if (track.pendingConceal.length > 0) {\n            const outSeq = BigInt(Math.round(audioData.timestamp / track.frameDurationUs));\n            while (track.pendingConceal.length > 0 && track.pendingConceal[0] < outSeq) {\n              track.pendingConceal.shift();\n              if (zeroPcm.length < need) zeroPcm = new Float32Array(need);\n              jbuf.write(zeroPcm.subarray(0, need));\n            }\n          }\n          if (decodePcm.length < need) decodePcm = new Float32Array(need);\n          const pcm = decodePcm.subarray(0, need);\n          copyDecoded(audioData, pcm, frames, channels);\n          jbuf.write(pcm);\n          const fmtKey = `${channels}|${audioData.sampleRate}|${audioData.format ?? "?"}|${copyPath}`;\n          if (fmtKey !== track.formatKey) {\n            track.formatKey = fmtKey;\n            post({\n              type: "decodedFormat",\n              trackAlias: cmd.trackAlias,\n              numberOfChannels: channels,\n              sampleRate: audioData.sampleRate,\n              nativeFormat: audioData.format ?? null,\n              copyPath\n            });\n          }\n        } catch (e) {\n          post({ type: "notice", event: "decode-error", detail: String(e) });\n        } finally {\n          audioData.close();\n        }\n      },\n      error: (e) => {\n        post({\n          type: "notice",\n          event: "decode-error",\n          detail: `alias ${cmd.trackAlias}: decoder failed, sink track cleared: ${String(e)}`\n        });\n        if (sinkTracks.get(cmd.trackAlias) === track) clearSinkTrack(cmd.trackAlias);\n      }\n    })\n  };\n  track.decoder.configure({\n    codec: cmd.decoderConfig.codec,\n    sampleRate: cmd.decoderConfig.sampleRate,\n    numberOfChannels: cmd.decoderConfig.numberOfChannels,\n    // Real-time hint: don\'t batch input chunks before emitting output.\n    optimizeForLatency: true\n  });\n  sinkTracks.set(cmd.trackAlias, track);\n}\nfunction clearSinkTrack(trackAlias) {\n  const track = sinkTracks.get(trackAlias);\n  if (!track) return;\n  sinkTracks.delete(trackAlias);\n  clearInterval(track.ingressTimer);\n  try {\n    track.decoder.close();\n  } catch {\n  }\n}\nasync function handleSetCaptureTrack(cmd) {\n  if (capturesStarting.has(cmd.entityId)) {\n    throw new Error(`capture for entity ${cmd.entityId} is already starting`);\n  }\n  capturesStarting.add(cmd.entityId);\n  try {\n    await setCaptureTrackInner(cmd);\n  } finally {\n    capturesStarting.delete(cmd.entityId);\n  }\n}\nasync function setCaptureTrackInner(cmd) {\n  if (!conn) throw new Error("not connected");\n  await stopCapture(cmd.entityId);\n  const trackAlias = await waitForEntityAlias(cmd.entityId);\n  const sender = conn;\n  const ring = new CaptureRing({\n    numChannels: cmd.numChannels,\n    capacityFrames: cmd.capacityFrames,\n    sharedStorage: cmd.sharedStorage,\n    sharedWritePos: cmd.sharedWritePos,\n    sharedReadPos: cmd.sharedReadPos\n  });\n  const ec = cmd.encoderConfig;\n  const sequencer = sourceFor(cmd.entityId);\n  if (ec.redundancy !== void 0) sequencer.setRedundancy(ec.redundancy);\n  const encoder = new CaptureEncoder({\n    ring,\n    trackAlias,\n    sampleRate: ec.sampleRate,\n    numChannels: ec.numberOfChannels,\n    poseCell: new PoseCell({ seq: cmd.poseSeq, values: cmd.poseValues }),\n    sequencer,\n    // Inject the real WebCodecs encoder + AudioData (kept out of\n    // CaptureEncoder so its logic stays unit-testable).\n    makeEncoder: (onChunk) => {\n      const audioEncoder = new AudioEncoder({\n        output: (chunk) => onChunk(chunk),\n        error: (e) => post({ type: "notice", event: "encode-error", detail: String(e) })\n      });\n      audioEncoder.configure({\n        codec: ec.codec,\n        sampleRate: ec.sampleRate,\n        numberOfChannels: ec.numberOfChannels,\n        bitrate: ec.bitrate,\n        opus: { frameDuration: ec.frameDurationUs }\n      });\n      return {\n        encode: (samples, frames, timestampUs) => {\n          const audioData = new AudioData({\n            format: "f32",\n            sampleRate: ec.sampleRate,\n            numberOfFrames: frames,\n            numberOfChannels: ec.numberOfChannels,\n            timestamp: timestampUs,\n            // AudioData copies synchronously, so the scratch is\n            // reusable right after (cast past ArrayBufferLike strictness).\n            data: samples\n          });\n          try {\n            audioEncoder.encode(audioData);\n          } finally {\n            audioData.close();\n          }\n        },\n        flush: () => audioEncoder.flush(),\n        close: () => {\n          if (audioEncoder.state !== "closed") audioEncoder.close();\n        }\n      };\n    },\n    send: (bytes) => {\n      void sender.sendDatagram(bytes).catch(() => {\n      });\n    }\n  });\n  const capture = { entityId: cmd.entityId, encoder, signal: cmd.sharedSignal, running: true };\n  captures.set(cmd.entityId, capture);\n  startCaptureLoop(capture);\n}\nfunction startCaptureLoop(capture) {\n  const signal = capture.signal;\n  const enc = capture.encoder;\n  const waitAsync = Atomics.waitAsync;\n  void (async () => {\n    let seen = Atomics.load(signal, 0);\n    while (capture.running) {\n      try {\n        enc.pump();\n      } catch (e) {\n        post({ type: "notice", event: "encode-error", detail: `${capture.entityId}: ${String(e)}` });\n        if (captures.get(capture.entityId) === capture) {\n          await stopCapture(capture.entityId).catch(() => {\n          });\n        }\n        return;\n      }\n      if (waitAsync) {\n        const r = waitAsync(signal, 0, seen);\n        if (r.async) await r.value;\n      } else {\n        await new Promise((res) => setTimeout(res, 2));\n      }\n      seen = Atomics.load(signal, 0);\n    }\n  })();\n}\nasync function stopCapture(entityId) {\n  const capture = captures.get(entityId);\n  if (!capture) return;\n  captures.delete(entityId);\n  capture.running = false;\n  Atomics.add(capture.signal, 0, 1);\n  Atomics.notify(capture.signal, 0, 1);\n  await capture.encoder.stop();\n}\nasync function handleWriteState(cmd) {\n  if (!conn) throw new Error("not connected");\n  if (stateSourceAlias === null) {\n    await new Promise((resolve, reject) => {\n      const timer = setTimeout(\n        () => reject(new Error("server did not subscribe the client state source in 5000ms")),\n        5e3\n      );\n      stateAliasWaiters.push(() => {\n        clearTimeout(timer);\n        resolve();\n      });\n    });\n  }\n  if (!stateWriterPromise) {\n    const alias = stateSourceAlias;\n    const p = conn.createSendStream().then((stream) => {\n      stateWriter = new SubgroupWriter(stream, alias, 0n, 0n, 0);\n      return stateWriter;\n    });\n    p.catch(() => {\n      if (stateWriterPromise === p) stateWriterPromise = null;\n    });\n    stateWriterPromise = p;\n  }\n  const writer = await stateWriterPromise;\n  for (const payload of cmd.payloads) {\n    await writer.writeObject(stateObjId++, payload);\n  }\n}\nasync function handleClose() {\n  for (const entityId of [...captures.keys()]) await stopCapture(entityId);\n  for (const alias of [...sinkTracks.keys()]) clearSinkTrack(alias);\n  if (stateWriter) {\n    try {\n      await stateWriter.close();\n    } catch {\n    }\n    stateWriter = null;\n  }\n  stateWriterPromise = null;\n  if (session) {\n    await session.close();\n    session = null;\n  }\n  if (conn) {\n    conn.close();\n    conn = null;\n  }\n  stateSourceAlias = null;\n  stateAliasWaiters = [];\n}\nctx.onmessage = (e) => {\n  const cmd = e.data;\n  switch (cmd.type) {\n    case "connect":\n      handleConnect(cmd).then(\n        () => post({ type: "connected", id: cmd.id }),\n        async (err) => {\n          for (let i = 0; i < 10 && lastCloseInfo === null; i++) {\n            await new Promise((r) => setTimeout(r, 50));\n          }\n          post({\n            type: "fail",\n            id: cmd.id,\n            message: String(err),\n            closeCode: lastCloseInfo?.closeCode,\n            closeReason: lastCloseInfo?.reason\n          });\n        }\n      );\n      break;\n    case "subscribe":\n      handleSubscribe(cmd).catch((err) => post({ type: "fail", id: cmd.id, message: String(err) }));\n      break;\n    case "sendDatagram":\n      if (conn) {\n        conn.sendDatagram(cmd.bytes).catch((err) => log("sendDatagram failed:", err));\n      }\n      break;\n    case "publish":\n      try {\n        handlePublish(cmd);\n      } catch (err) {\n        post({ type: "notice", event: "publish-dropped", detail: `${cmd.entityId}: ${String(err)}` });\n      }\n      break;\n    case "writeState":\n      handleWriteState(cmd).then(\n        () => post({ type: "stateWritten", id: cmd.id }),\n        (err) => post({ type: "fail", id: cmd.id, message: String(err) })\n      );\n      break;\n    case "setSinkTrack":\n      try {\n        handleSetSinkTrack(cmd);\n        post({ type: "sinkTrackSet", id: cmd.id });\n      } catch (err) {\n        post({ type: "fail", id: cmd.id, message: String(err) });\n      }\n      break;\n    case "clearSinkTrack":\n      clearSinkTrack(cmd.trackAlias);\n      post({ type: "sinkTrackCleared", id: cmd.id });\n      break;\n    case "setCaptureTrack":\n      handleSetCaptureTrack(cmd).then(\n        () => post({ type: "captureTrackSet", id: cmd.id }),\n        (err) => post({ type: "fail", id: cmd.id, message: String(err) })\n      );\n      break;\n    case "stopCapture":\n      stopCapture(cmd.entityId).then(\n        () => post({ type: "captureStopped", id: cmd.id }),\n        (err) => post({ type: "fail", id: cmd.id, message: String(err) })\n      );\n      break;\n    case "close":\n      handleClose().then(\n        () => post({ type: "closed", id: cmd.id }),\n        (err) => post({ type: "fail", id: cmd.id, message: String(err) })\n      );\n      break;\n  }\n};\n';
const blob = typeof self !== "undefined" && self.Blob && new Blob(["URL.revokeObjectURL(import.meta.url);", jsContent], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, {
      type: "module",
      name: options?.name
    });
    worker.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(objURL);
    });
    return worker;
  } catch (e) {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent),
      {
        type: "module",
        name: options?.name
      }
    );
  }
}
function createMoqWorker() {
  return new WorkerWrapper();
}
class MoqClientError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "MoqClientError";
  }
}
function fecFloor(maxOffset, writerFrame) {
  if (maxOffset <= 0) return 0;
  return 2 * (maxOffset + 2) * writerFrame;
}
function computeJitterCapacity(cfg = {}) {
  const sr = cfg.sampleRate ?? 48e3;
  const nc = cfg.numChannels ?? 1;
  const f = (ms) => Math.trunc(ms * sr / 1e3);
  const W = cfg.writerFrame ?? 0;
  const R = cfg.readerFrame ?? 0;
  if (W <= 0 || R <= 0) {
    throw new Error("computeJitterCapacity: readerFrame and writerFrame must be > 0");
  }
  const S = cfg.safety || f(1);
  const level = cfg.qualityLevel ?? 0;
  let qFloor = 0;
  let qRob = 1;
  let qCap = 0;
  if (level === 1) {
    qFloor = f(50);
    qRob = 4;
    qCap = f(500);
  } else if (level >= 2) {
    qFloor = f(150);
    qRob = 8;
    qCap = f(400);
  }
  const flDecl = Math.max(cfg.floor ?? 0, qFloor);
  let kappa = cfg.robustness ?? qRob;
  if (kappa < 1) kappa = 1;
  const kLow = 1.2 * kappa;
  const kHigh = 1.5 * kappa;
  const wlCap = Math.trunc(f(30) * kappa);
  const whCap = Math.trunc(f(60) * kappa);
  const spBase = Math.max(R + S, R + W);
  const spMax = Math.max(spBase + Math.trunc(kLow * wlCap), flDecl);
  let capacity = cfg.capacity ?? qCap;
  if (!capacity) {
    capacity = 2 * (spMax + Math.trunc(kHigh * whCap)) + 2 * Math.max(W, R);
  }
  return { capacity, nc };
}
class JitterBufferCore {
  // ---- immutable geometry (frames) ----
  capacity;
  w;
  r;
  s;
  nc;
  sampleRate;
  // ---- immutable derived tuning (Go: the ctor-derived block) ----
  windowReads;
  freezeReads;
  narrowStep;
  // frames per window (float; ÷κ)
  spBase;
  // max(R+S, R+W): the structural lattice floor
  flDecl;
  // declared floor; composes by MAX
  kLow;
  kHigh;
  wlCap;
  deadband;
  gain;
  rateCap;
  ffClamp;
  ffDeadZone;
  theta;
  spMax;
  // ---- storage: capacity * nc interleaved floats ----
  data;
  // ---- SPSC heads — cumulative (never wrap). Index via (pos % capacity) * nc. ----
  // writePos crosses the writer→reader thread boundary in SAB mode, so it is
  // backed by an atomic cell when `sharedWritePos` is given; otherwise a plain
  // number. The Atomics.store/load act as the release/acquire fence pairing
  // the ring writes (writer) with the ring reads (reader) — the Go SPSC
  // contract. readPos is reader-owned (the writer never touches it): plain.
  _writePos = 0;
  wpCell = null;
  get writePos() {
    return this.wpCell ? Number(Atomics.load(this.wpCell, 0)) : this._writePos;
  }
  set writePos(v) {
    if (this.wpCell) Atomics.store(this.wpCell, 0, BigInt(v));
    else this._writePos = v;
  }
  readPos = 0;
  // ---- reader-owned sensing/controller state ----
  started = false;
  tick = 0;
  // read count since start — the sensing clock
  lastWp = 0;
  gapRun = 0;
  frozen = false;
  // Current sensing window: pre-read raw fill + virtual signal, appended
  // together (one shared count). Preallocated — no steady-state allocation
  // on the audio thread.
  rawBuf;
  virtBuf;
  sortBuf;
  winCount = 0;
  // Last K windows' measured widths (rings) for the rank filter.
  wlHist;
  whHist;
  histLen = 0;
  histPos = 0;
  // Feed-forward drift estimator: (tick, window-median virtual) pairs across
  // the last K window closes. Reset on freeze-resume so an outage's virtual
  // step never reads as drift.
  ffTicks;
  ffVals;
  ffLen = 0;
  // Held effective widths (frames, float), servo rate, debt, pending trim.
  // Public for white-box tests and observability (v3 convention: outside
  // write/read they are read-only; mutating by hand is a test seam only).
  wl = 0;
  wh = 0;
  rate = 0;
  // frames/s of read time; + = drop
  debt = 0;
  pendingTrim = 0;
  /** Live setpoint (pre-read fill target, frames). Reader-written; observers read. */
  setpoint;
  // ---- cumulative stats (reader-owned plain numbers) ----
  underruns = 0;
  laps = 0;
  overruns = 0;
  trims = 0;
  samplesDropped = 0;
  samplesInserted = 0;
  constructor(cfg = {}) {
    const sr = cfg.sampleRate ?? 48e3;
    const nc = cfg.numChannels ?? 1;
    const f = (ms) => Math.trunc(ms * sr / 1e3);
    const W = cfg.writerFrame ?? 0;
    const R = cfg.readerFrame ?? 0;
    if (W <= 0 || R <= 0) {
      throw new Error("JitterBufferCore: readerFrame and writerFrame must be > 0 (the caller declares its geometry)");
    }
    const S = cfg.safety || f(1);
    const level = cfg.qualityLevel ?? 0;
    let qFloor = 0;
    let qRob = 1;
    let qCap = 0;
    if (level === 1) {
      qFloor = f(50);
      qRob = 4;
      qCap = f(500);
    } else if (level >= 2) {
      qFloor = f(150);
      qRob = 8;
      qCap = f(400);
    }
    const flDecl = Math.max(cfg.floor ?? 0, qFloor);
    let kappa = cfg.robustness ?? qRob;
    if (kappa < 1) kappa = 1;
    const deadband = f(0.25);
    const spBase = Math.max(R + S, R + W);
    const kLow = 1.2 * kappa;
    const kHigh = 1.5 * kappa;
    const wlCap = Math.trunc(f(30) * kappa);
    const whCap = Math.trunc(f(60) * kappa);
    let spMax = Math.max(spBase + Math.trunc(kLow * wlCap), flDecl);
    let ffDeadZone = Math.trunc(this.gcd(W, R) / 2);
    if (ffDeadZone < 1) ffDeadZone = 1;
    const theta = W + Math.trunc(20 * 2);
    let capacity = cfg.capacity ?? qCap;
    if (!capacity) {
      capacity = 2 * (spMax + Math.trunc(kHigh * whCap)) + 2 * Math.max(W, R);
    }
    const reserve = 4 * Math.max(W, R);
    if (spMax > capacity - reserve) {
      spMax = Math.max(spBase, capacity - reserve);
    }
    this.capacity = capacity;
    this.w = W;
    this.r = R;
    this.s = S;
    this.nc = nc;
    this.sampleRate = sr;
    this.windowReads = Math.trunc(2 * sr / R);
    this.freezeReads = Math.max(8, Math.trunc(f(40) / R));
    this.narrowStep = f(0.5) / kappa;
    this.spBase = spBase;
    this.flDecl = flDecl;
    this.kLow = kLow;
    this.kHigh = kHigh;
    this.wlCap = wlCap;
    this.deadband = deadband;
    this.gain = 0.01;
    this.rateCap = 20;
    this.ffClamp = 22;
    this.ffDeadZone = ffDeadZone;
    this.theta = theta;
    this.spMax = spMax;
    if (cfg.sharedStorage) {
      if (cfg.sharedStorage.length !== capacity * nc) {
        throw new Error(
          `JitterBufferCore: sharedStorage length ${cfg.sharedStorage.length} != capacity*nc ${capacity * nc} (size it with computeJitterCapacity using the same config)`
        );
      }
      this.data = cfg.sharedStorage;
    } else {
      this.data = new Float32Array(capacity * nc);
    }
    if (cfg.sharedWritePos) {
      if (cfg.sharedWritePos.length < 1) {
        throw new Error("JitterBufferCore: sharedWritePos must be a length-1 BigInt64Array");
      }
      this.wpCell = cfg.sharedWritePos;
    }
    this.rawBuf = new Float64Array(this.windowReads);
    this.virtBuf = new Float64Array(this.windowReads);
    this.sortBuf = new Float64Array(this.windowReads);
    this.wlHist = new Float64Array(10);
    this.whHist = new Float64Array(10);
    this.ffTicks = new Float64Array(10);
    this.ffVals = new Float64Array(10);
    this.setpoint = Math.min(Math.max(spBase, flDecl), spMax);
  }
  /**
   * Copy `src` (interleaved, length a multiple of `nc`) into the ring. Never
   * blocks; writes larger than capacity are clipped to the most-recent
   * frames. Identical to v3 (and to Go `Write`).
   */
  write(src) {
    let nFrames = Math.floor(src.length / this.nc);
    if (nFrames === 0) return;
    if (nFrames > this.capacity) {
      const skip = nFrames - this.capacity;
      src = src.subarray(skip * this.nc);
      nFrames = this.capacity;
    }
    const wp = this.writePos;
    this.writeToRing(src, wp, nFrames);
    this.writePos = wp + nFrames;
  }
  /**
   * Copy up to `dst.length` interleaved samples from the ring, returning
   * true when audio was produced. Order per read (Go `Read`): startup gate →
   * pending macro-trim → capacity valves → sense → underrun valve → play
   * with debt-bucket splice.
   */
  read(dst) {
    const nc = this.nc;
    const nFrames = Math.floor(dst.length / nc);
    if (nFrames === 0) return true;
    const wp = this.writePos;
    let rp = this.readPos;
    const sp = this.setpoint;
    if (rp === 0) {
      if (wp < sp) {
        dst.fill(0);
        return false;
      }
      rp = wp - sp;
      this.readPos = rp;
      this.started = true;
      this.lastWp = wp;
    }
    if (this.pendingTrim > 0) {
      const t = Math.min(this.pendingTrim, wp - rp - sp);
      if (t > 0) {
        rp += t;
        this.readPos = rp;
        this.trims++;
      }
      this.pendingTrim = 0;
      this.resetWindow();
    }
    let fill = wp - rp;
    if (fill >= this.capacity) {
      rp = wp - sp;
      this.readPos = rp;
      fill = sp;
      this.laps++;
      this.resetWindow();
    } else if (fill > this.capacity - (this.w + this.r)) {
      rp = wp - sp;
      this.readPos = rp;
      fill = sp;
      this.overruns++;
      this.resetWindow();
    }
    this.sense(wp, fill);
    if (fill < nFrames) {
      dst.fill(0);
      this.underruns++;
      return false;
    }
    if (!this.frozen) {
      this.debt += this.rate * this.r / this.sampleRate;
      if (this.debt > 1.5) this.debt = 1.5;
      else if (this.debt < -1.5) this.debt = -1.5;
    }
    if (this.debt >= 1 && fill >= nFrames + 1) {
      this.debt--;
      this.spliceDrop(dst, rp, nFrames);
      this.readPos = rp + nFrames + 1;
      this.samplesDropped++;
    } else if (this.debt <= -1 && nFrames >= 2) {
      this.debt++;
      this.spliceInsert(dst, rp, nFrames);
      this.readPos = rp + nFrames - 1;
      this.samplesInserted++;
    } else {
      this.readFromRing(dst, rp, nFrames);
      this.readPos = rp + nFrames;
    }
    return true;
  }
  /**
   * Feed one pre-read observation into the sensing window and run the
   * freeze/excise rule (design §3): a no-delivery run longer than
   * `freezeReads` freezes sensing and the servo, and retroactively rewinds
   * the run's own dip samples out of the window — outage, loss bursts and
   * device stalls teach the estimator nothing. Short dips (a late packet, a
   * lost packet) stay in: they are lateness evidence.
   */
  sense(wp, fill) {
    if (!this.started) return;
    const tick = this.tick;
    this.tick++;
    const delta = wp - this.lastWp;
    this.lastWp = wp;
    if (delta > 0) {
      if (this.frozen) {
        this.frozen = false;
        this.resetWindow();
        this.ffLen = 0;
      }
      this.gapRun = 0;
    } else {
      this.gapRun++;
      if (!this.frozen && this.gapRun > this.freezeReads) {
        this.frozen = true;
        this.rate = 0;
        this.debt = 0;
        const rw = Math.min(this.gapRun - 1, this.winCount);
        this.winCount -= rw;
      }
    }
    if (this.frozen) return;
    this.rawBuf[this.winCount] = fill;
    this.virtBuf[this.winCount] = wp - this.r * tick;
    this.winCount++;
    if (this.winCount >= this.windowReads) {
      this.closeWindow();
    }
  }
  /**
   * Compute the window estimates, update the width hold, the FF drift
   * estimate and the setpoint, then run the shipped control law (Go
   * `closeWindow` + `PServo.Decide`, inlined — the TS build is monomorphic;
   * the Go Controller seam is test scaffolding the port does not need).
   */
  closeWindow() {
    const n = this.winCount;
    let s = this.sortBuf.subarray(0, n);
    s.set(this.rawBuf.subarray(0, n));
    s.sort();
    const medRaw = s[n >> 1];
    const minRaw = s[0];
    s = this.sortBuf.subarray(0, n);
    s.set(this.virtBuf.subarray(0, n));
    s.sort();
    const medV = s[n >> 1];
    const minV = s[0];
    const maxV = s[n - 1];
    const wlMeas = Math.min(medV - minV, this.wlCap);
    const whMeas = maxV - medV;
    this.wlHist[this.histPos] = wlMeas;
    this.whHist[this.histPos] = whMeas;
    this.histPos = (this.histPos + 1) % 10;
    if (this.histLen < 10) this.histLen++;
    const wlEff = this.rankNth(this.wlHist, this.histLen, 3);
    const whEff = this.rankNth(this.whHist, this.histLen, 3);
    this.wl = Math.max(wlEff, this.wl - this.narrowStep);
    this.wh = Math.max(whEff, this.wh - this.narrowStep);
    if (this.ffLen >= 10) {
      this.ffTicks.copyWithin(0, 1);
      this.ffVals.copyWithin(0, 1);
      this.ffLen = 9;
    }
    this.ffTicks[this.ffLen] = this.tick;
    this.ffVals[this.ffLen] = medV;
    this.ffLen++;
    let slope = 0;
    const fn = this.ffLen;
    if (fn >= 2 && this.ffTicks[fn - 1] > this.ffTicks[0]) {
      let lo = this.ffVals[0];
      let hi = this.ffVals[fn - 1];
      let ta = this.ffTicks[0];
      let tb = this.ffTicks[fn - 1];
      if (fn >= 6) {
        lo = this.median3(this.ffVals[0], this.ffVals[1], this.ffVals[2]);
        hi = this.median3(this.ffVals[fn - 3], this.ffVals[fn - 2], this.ffVals[fn - 1]);
        ta = this.ffTicks[1];
        tb = this.ffTicks[fn - 2];
      }
      const span = tb - ta;
      if (span > 0) {
        const perRead = (hi - lo) / span;
        const d = perRead * span;
        if (d >= this.ffDeadZone || d <= -this.ffDeadZone) {
          slope = perRead * this.sampleRate / this.r;
        }
      }
    }
    const dbEff = Math.max(this.deadband, Math.trunc(this.wl));
    const sp = Math.min(Math.max(this.spBase + Math.trunc(this.kLow * this.wl + 0.5), this.flDecl), this.spMax);
    this.setpoint = sp;
    let rate = 0;
    let trim = 0;
    if (minRaw - sp > this.theta) {
      trim = medRaw - sp;
    } else {
      let ff = slope;
      if (ff > this.ffClamp || ff < -this.ffClamp) {
        ff = this.ffClamp * this.ffClamp / ff;
      }
      let p = 0;
      const e = medRaw - sp;
      if (e > dbEff) {
        p = this.gain * (e - dbEff);
      }
      rate = p + ff;
      if (rate > this.rateCap) rate = this.rateCap;
      else if (rate < -this.rateCap) rate = -this.rateCap;
    }
    this.rate = rate;
    if (trim > 0) this.pendingTrim = trim;
    this.resetWindow();
  }
  resetWindow() {
    this.winCount = 0;
  }
  /**
   * The n-th highest of the first `len` values — the width recurrence
   * filter (Go `rankNth`). Short histories use their lowest value (a width
   * is only believed once seen n times).
   */
  rankNth(h, len, n) {
    if (len < n) n = len;
    const top = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < len; k++) {
      const v = h[k];
      for (let i = 0; i < n; i++) {
        if (v > top[i]) {
          for (let j = n - 1; j > i; j--) top[j] = top[j - 1];
          top[i] = v;
          break;
        }
      }
    }
    return top[n - 1];
  }
  /** Median of three values (Go `median3`). */
  median3(a, b, c) {
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (b > c) b = c;
    return a > b ? a : b;
  }
  /** Greatest common divisor of two positive values (Go `gcd`). */
  gcd(a, b) {
    while (b !== 0) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  }
  /**
   * Consume nFrames+1 ring frames into an nFrames output with one frame
   * removed at the grade-1 cut: the adjacent consumed pair with the minimum
   * summed per-channel discontinuity, averaged into a single boundary frame
   * (the decoder's drop marker, at any in-block position). Go `spliceDrop`.
   */
  spliceDrop(dst, rp, nFrames) {
    const nc = this.nc;
    const cap = this.capacity;
    let cut = 0;
    let best = -1;
    for (let i = 0; i < nFrames; i++) {
      const d = this.frameDiff(rp + i, rp + i + 1);
      if (best < 0 || d <= best) {
        best = d;
        cut = i;
      }
    }
    for (let j = 0; j < nFrames; j++) {
      let src = rp + j;
      if (j > cut) src++;
      const sb = src % cap * nc;
      const db = j * nc;
      if (j === cut) {
        const nb = (src + 1) % cap * nc;
        for (let ch = 0; ch < nc; ch++) {
          dst[db + ch] = Math.fround(this.data[sb + ch] + this.data[nb + ch]) * 0.5;
        }
        continue;
      }
      for (let ch = 0; ch < nc; ch++) dst[db + ch] = this.data[sb + ch];
    }
  }
  /**
   * Consume nFrames−1 ring frames into an nFrames output with one synthetic
   * frame added at the grade-1 cut: the average of the adjacent pair around
   * it (the decoder's insert marker). Go `spliceInsert`.
   */
  spliceInsert(dst, rp, nFrames) {
    const nc = this.nc;
    const cap = this.capacity;
    let cut = 1;
    let best = -1;
    for (let i = 1; i < nFrames; i++) {
      const d = this.frameDiff(rp + i - 1, rp + i);
      if (best < 0 || d <= best) {
        best = d;
        cut = i;
      }
    }
    for (let j = 0; j < nFrames; j++) {
      let src = rp + j;
      if (j > cut) src--;
      const db = j * nc;
      if (j === cut) {
        const ab = (rp + cut - 1) % cap * nc;
        const bb = (rp + cut) % cap * nc;
        for (let ch = 0; ch < nc; ch++) {
          dst[db + ch] = Math.fround(this.data[ab + ch] + this.data[bb + ch]) * 0.5;
        }
        continue;
      }
      const sb = src % cap * nc;
      for (let ch = 0; ch < nc; ch++) dst[db + ch] = this.data[sb + ch];
    }
  }
  /**
   * Summed per-channel discontinuity between two frames, in float32
   * arithmetic (`Math.fround` mirrors Go's float32 ops so the placement
   * scan picks the identical cut — the fixture replay depends on it).
   */
  frameDiff(p, q) {
    const nc = this.nc;
    const cap = this.capacity;
    const pb = p % cap * nc;
    const qb = q % cap * nc;
    let d = 0;
    for (let ch = 0; ch < nc; ch++) {
      let x = Math.fround(this.data[pb + ch] - this.data[qb + ch]);
      if (x < 0) x = -x;
      d = Math.fround(d + x);
    }
    return d;
  }
  /** Current fill in frames. */
  fillFrames() {
    return this.writePos - this.readPos;
  }
  /** Fill in interleaved floats (matching the Go ICircularBuffer convention). */
  getBehind() {
    return this.fillFrames() * this.nc;
  }
  /** Rich snapshot for tuning/observability (Go `Snapshot`). */
  snapshot() {
    const srMs = this.sampleRate / 1e3;
    const fill = this.fillFrames();
    const wl = Math.trunc(this.wl);
    const wh = Math.trunc(this.wh);
    return {
      fillFrames: fill,
      fillMs: fill / srMs,
      setpointFrames: this.setpoint,
      setpointMs: this.setpoint / srMs,
      widthLowFrames: wl,
      widthLowMs: wl / srMs,
      widthHighFrames: wh,
      widthHighMs: wh / srMs,
      ratePerSec: this.rate,
      frozen: this.frozen,
      started: this.readPos > 0,
      underruns: this.underruns,
      overruns: this.overruns,
      laps: this.laps,
      trims: this.trims,
      samplesDropped: this.samplesDropped,
      samplesInserted: this.samplesInserted
    };
  }
  /**
   * Copy `nFrames` frames from `src` into the ring at frame position `wp`,
   * handling wraparound. Caller guarantees `nFrames <= capacity`.
   */
  writeToRing(src, wp, nFrames) {
    const cap = this.capacity;
    const nc = this.nc;
    const startFrame = wp % cap;
    if (startFrame + nFrames <= cap) {
      this.data.set(src.subarray(0, nFrames * nc), startFrame * nc);
      return;
    }
    const first = cap - startFrame;
    this.data.set(src.subarray(0, first * nc), startFrame * nc);
    this.data.set(src.subarray(first * nc, nFrames * nc), 0);
  }
  /**
   * Copy `nFrames` frames from the ring at frame position `rp` into `dst`,
   * handling wraparound. Caller guarantees `nFrames <= capacity`.
   */
  readFromRing(dst, rp, nFrames) {
    const cap = this.capacity;
    const nc = this.nc;
    const startFrame = rp % cap;
    if (startFrame + nFrames <= cap) {
      dst.set(this.data.subarray(startFrame * nc, (startFrame + nFrames) * nc));
      return;
    }
    const first = cap - startFrame;
    dst.set(this.data.subarray(startFrame * nc, cap * nc), 0);
    dst.set(this.data.subarray(0, (nFrames - first) * nc), first * nc);
  }
}
class StereoMeterCore {
  sumLL = 0;
  sumRR = 0;
  sumLR = 0;
  frames = 0;
  /** Frames accumulated since the last snapshot (drives window emission). */
  get frameCount() {
    return this.frames;
  }
  /**
   * Accumulate interleaved PCM (LRLR… for stereo). `channels` is the interleave
   * stride; only the first two channels are measured. Mono input (channels=1)
   * is treated as L=R — it reports correlation 1 / sideRms 0, which is the
   * correct verdict for it.
   */
  writeInterleaved(pcm, channels) {
    if (channels < 1) return;
    const n = Math.floor(pcm.length / channels);
    for (let i = 0; i < n; i++) {
      const l = pcm[i * channels];
      const r = channels > 1 ? pcm[i * channels + 1] : l;
      this.sumLL += l * l;
      this.sumRR += r * r;
      this.sumLR += l * r;
    }
    this.frames += n;
  }
  /** Accumulate planar channels (the worklet's output layout). `right` null ⇒ mono. */
  writePlanar(left, right, count) {
    for (let i = 0; i < count; i++) {
      const l = left[i];
      const r = right ? right[i] : l;
      this.sumLL += l * l;
      this.sumRR += r * r;
      this.sumLR += l * r;
    }
    this.frames += count;
  }
  /** Produce the window report and reset the accumulators. */
  snapshotAndReset() {
    const f = this.frames;
    const ll = this.sumLL;
    const rr = this.sumRR;
    const lr = this.sumLR;
    this.sumLL = 0;
    this.sumRR = 0;
    this.sumLR = 0;
    this.frames = 0;
    if (f === 0) {
      return { frames: 0, rmsL: 0, rmsR: 0, midRms: 0, sideRms: 0, correlation: 0 };
    }
    const rmsL = Math.sqrt(ll / f);
    const rmsR = Math.sqrt(rr / f);
    const midRms = Math.sqrt(Math.max(0, ll + rr + 2 * lr) / (4 * f));
    const sideRms = Math.sqrt(Math.max(0, ll + rr - 2 * lr) / (4 * f));
    const denom = Math.sqrt(ll * rr);
    const correlation = denom > 1e-20 ? Math.max(-1, Math.min(1, lr / denom)) : 0;
    return { frames: f, rmsL, rmsR, midRms, sideRms, correlation };
  }
}
const PLAYOUT_PROCESSOR_NAME = "playout-processor";
const PLAYOUT_PROCESSOR_SOURCE = `
class PlayoutRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const config = opts.config || {};
    // SAB-only: the ring is written by the MOQ worker through shared memory.
    // Fail loudly at construction rather than render silence forever.
    if (!config.sharedStorage || !config.sharedWritePos) {
      throw new Error('PlayoutRingProcessor: config.sharedStorage + sharedWritePos are required (SAB-only playout)');
    }
    this.core = new JitterBufferCore(config);
    this.nc = this.core.nc;
    this.statsEvery = opts.statsEvery || 94;
    this.readsSinceStats = 0;
    // True fill min/max across the stats window (every read, not the 250 ms
    // point-sample): shows the real sawtooth amplitude from reader bursts.
    this.winFillMin = 1e9;
    this.winFillMax = 0;
    this.scratch = new Float32Array(128 * this.nc);
    // Tap B stereo meter over the rendered output (3 multiply-adds per frame —
    // negligible, so it is unconditionally on; the main thread decides usage).
    this.meter = new StereoMeterCore();
    // Discontinuity-event detection: previous counter values, diffed
    // after every read so events post the moment they happen.
    this.totalReads = 0;
    this.prevUnderruns = 0;
    this.prevOverruns = 0;
    this.prevLaps = 0;
    this.prevTrims = 0;
    this.prevInserted = 0;
    this.prevDropped = 0;
    // this.port is OUTBOUND only (stats); no PCM ever arrives via messages.
  }

  // Post any counter increments since the last read as events (rare —
  // a healthy stream posts none; this is not a per-read allocation path
  // in the steady state).
  emitEvent(kind, n, fill) {
    for (let i = 0; i < n; i++) {
      this.port.postMessage({ type: 'event', kind, fillFrames: fill, reads: this.totalReads });
    }
  }

  postEvents() {
    const c = this.core;
    const fill = c.fillFrames();
    if (c.underruns !== this.prevUnderruns) this.emitEvent('underrun', c.underruns - this.prevUnderruns, fill);
    if (c.overruns !== this.prevOverruns) this.emitEvent('overrun', c.overruns - this.prevOverruns, fill);
    if (c.laps !== this.prevLaps) this.emitEvent('lap', c.laps - this.prevLaps, fill);
    if (c.trims !== this.prevTrims) this.emitEvent('trim', c.trims - this.prevTrims, fill);
    if (c.samplesInserted !== this.prevInserted) this.emitEvent('insert', c.samplesInserted - this.prevInserted, fill);
    if (c.samplesDropped !== this.prevDropped) this.emitEvent('drop', c.samplesDropped - this.prevDropped, fill);
    this.prevUnderruns = c.underruns;
    this.prevOverruns = c.overruns;
    this.prevLaps = c.laps;
    this.prevTrims = c.trims;
    this.prevInserted = c.samplesInserted;
    this.prevDropped = c.samplesDropped;
  }

  // READER: pull one render quantum from the ring, deinterleave to outputs.
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0 || !out[0]) return true;
    const nFrames = out[0].length;
    const nc = this.nc;
    const need = nFrames * nc;
    if (this.scratch.length < need) this.scratch = new Float32Array(need);
    const block = this.scratch.subarray(0, need);
    // core.read zeroes the block on startup/underrun, so silence falls through.
    this.core.read(block);
    this.totalReads++;
    this.postEvents();
    const fill = this.core.fillFrames();
    if (fill < this.winFillMin) this.winFillMin = fill;
    if (fill > this.winFillMax) this.winFillMax = fill;
    for (let ch = 0; ch < out.length; ch++) {
      const dst = out[ch];
      const srcCh = ch < nc ? ch : nc - 1;
      for (let i = 0; i < nFrames; i++) dst[i] = block[i * nc + srcCh];
    }
    // Tap B: meter the planar output as rendered (mono if the node only has one
    // output channel — that itself is a finding).
    this.meter.writePlanar(out[0], out.length > 1 ? out[1] : null, nFrames);
    if (++this.readsSinceStats >= this.statsEvery) {
      this.readsSinceStats = 0;
      this.port.postMessage({
        type: 'stats',
        snapshot: this.core.snapshot(),
        fillMin: this.winFillMin,
        fillMax: this.winFillMax,
        stereo: this.meter.snapshotAndReset(),
      });
      this.winFillMin = 1e9;
      this.winFillMax = 0;
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PLAYOUT_PROCESSOR_NAME)}, PlayoutRingProcessor);
`;
function buildPlayoutWorkletCode() {
  const coreSource = JitterBufferCore.toString();
  const meterSource = StereoMeterCore.toString();
  if (!coreSource.startsWith("class")) {
    throw new Error("playout-worklet: JitterBufferCore.toString() is not a class declaration");
  }
  if (!meterSource.startsWith("class")) {
    throw new Error("playout-worklet: StereoMeterCore.toString() is not a class declaration");
  }
  const helper = /\b__(publicField|privateField|decorateClass|decorateParam|name|esDecorate)\b/.exec(
    coreSource + meterSource
  );
  if (helper) {
    throw new Error(
      `playout-worklet: serialized source references the bundler helper "${helper[0]}" — it would be undefined in the worklet. Ensure the build target keeps native class fields (es2022+).`
    );
  }
  return `const JitterBufferCore = ${coreSource};
const StereoMeterCore = ${meterSource};
${PLAYOUT_PROCESSOR_SOURCE}`;
}
function createPlayoutWorkletUrl() {
  const blob2 = new Blob([buildPlayoutWorkletCode()], { type: "application/javascript" });
  return URL.createObjectURL(blob2);
}
const RENDER_QUANTUM = 128;
const DEFAULT_WRITER_FRAME = 240;
const EVENT_RING_CAP = 500;
class SinkPlayer {
  constructor(audioContext, workletNode, gainNode, jbConfigBase, sharedStorage, sharedWritePos, opts) {
    this.audioContext = audioContext;
    this.workletNode = workletNode;
    this.gainNode = gainNode;
    this.jbConfigBase = jbConfigBase;
    this.sharedStorage = sharedStorage;
    this.sharedWritePos = sharedWritePos;
    this.opts = opts;
    workletNode.onprocessorerror = () => {
      this.processorError = new Error("playout worklet processor error (output is now silent)");
      console.error("[SinkPlayer]", this.processorError.message);
      this.events.push({ kind: "processor-error", fillFrames: 0, reads: 0, atMs: performance.now() });
      if (this.events.length > EVENT_RING_CAP) this.events.shift();
    };
    workletNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === "stats") {
        this.lastSnapshot = msg.snapshot;
        if (msg.stereo) this.lastTapB = msg.stereo;
        this.statsListener?.(msg.snapshot, msg.stereo ?? null, performance.now());
        this.logJitter(msg.snapshot, msg.fillMin, msg.fillMax);
      } else if (msg && msg.type === "event") {
        const ev = {
          kind: msg.kind,
          fillFrames: msg.fillFrames,
          reads: msg.reads,
          atMs: performance.now()
        };
        this.events.push(ev);
        if (this.events.length > EVENT_RING_CAP) this.events.shift();
        if (this.opts.debug) {
          const srMs = this.opts.sampleRate / 1e3;
          console.log(
            `[JBUF-EV] ${ev.kind} fill=${(ev.fillFrames / srMs).toFixed(1)}ms reads=${ev.reads} t=${ev.atMs.toFixed(0)}`
          );
        }
      }
    };
  }
  lastSnapshot = null;
  lastTapB = null;
  jbufLogCount = 0;
  statsListener = null;
  events = [];
  processorError = null;
  /**
   * Buffer discontinuities since start (bounded ring, newest last).
   * Each is an audible-artefact candidate: underrun = silence gap,
   * overrun/lap = snap, insert/drop = ±1 splice.
   */
  /** Set once the worklet processor has thrown; the player renders silence from then on. */
  getProcessorError() {
    return this.processorError;
  }
  /** Buffer discontinuities since the last {@link SinkPlayer.clearEvents}, oldest first (bounded ring). */
  getEvents() {
    return [...this.events];
  }
  /** Empties the event ring. */
  clearEvents() {
    this.events = [];
  }
  /**
   * Per-window stats callback (latency harnesses; null to remove).
   * Fires once per worklet stats window with its receipt timestamp.
   */
  setStatsListener(listener) {
    this.statsListener = listener;
  }
  /**
   * Builds the audio graph and the shared ring. Requires cross-origin
   * isolation (the SDK's hard requirement) — throws otherwise. Must be
   * called from a user-gesture context on browsers that require one for
   * AudioContext.
   */
  static async create(options = {}) {
    if (typeof SharedArrayBuffer === "undefined" || globalThis.crossOriginIsolated !== true) {
      throw new MoqClientError(
        "Sink playout requires cross-origin isolation (crossOriginIsolated) for the SharedArrayBuffer ring",
        "NOT_ISOLATED"
      );
    }
    const opts = {
      sampleRate: options.sampleRate ?? 48e3,
      channelCount: options.channelCount ?? 2,
      writerFrameSamples: options.writerFrameSamples ?? DEFAULT_WRITER_FRAME,
      redundancy: options.redundancy ?? 0,
      debug: options.debug ?? false
    };
    const audioContext = new AudioContext({
      sampleRate: opts.sampleRate,
      latencyHint: options.latencyHint ?? "interactive"
    });
    try {
      const url = createPlayoutWorkletUrl();
      try {
        await audioContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const jbConfigBase = {
        sampleRate: audioContext.sampleRate,
        numChannels: opts.channelCount,
        readerFrame: RENDER_QUANTUM,
        writerFrame: opts.writerFrameSamples,
        ...options.qualityLevel !== void 0 ? { qualityLevel: options.qualityLevel } : {},
        ...options.jitterConfig
      };
      if (opts.redundancy > 0) {
        jbConfigBase.floor = Math.max(jbConfigBase.floor ?? 0, fecFloor(opts.redundancy, opts.writerFrameSamples));
      }
      const { capacity, nc } = computeJitterCapacity(jbConfigBase);
      const sharedStorage = new Float32Array(new SharedArrayBuffer(capacity * nc * 4));
      const sharedWritePos = new BigInt64Array(new SharedArrayBuffer(8));
      const workletNode = new AudioWorkletNode(audioContext, PLAYOUT_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [opts.channelCount],
        processorOptions: {
          config: { ...jbConfigBase, sharedStorage, sharedWritePos },
          ...options.statsEvery !== void 0 ? { statsEvery: options.statsEvery } : {}
        }
      });
      const gainNode = audioContext.createGain();
      gainNode.connect(audioContext.destination);
      workletNode.connect(gainNode);
      return new SinkPlayer(audioContext, workletNode, gainNode, jbConfigBase, sharedStorage, sharedWritePos, opts);
    } catch (e) {
      await audioContext.close().catch(() => {
      });
      throw e;
    }
  }
  /** The shared ring + geometry for the worker's `setSinkTrack`. */
  getRingHandoff() {
    return {
      jbufConfig: this.jbConfigBase,
      sharedStorage: this.sharedStorage,
      sharedWritePos: this.sharedWritePos,
      redundancy: this.opts.redundancy
    };
  }
  /** The decoder config the worker should use for this player's sink. */
  getDecoderConfig(frameDurationUs = 5e3) {
    return {
      codec: "opus",
      sampleRate: this.opts.sampleRate,
      numberOfChannels: this.opts.channelCount,
      frameDurationUs
    };
  }
  /** Resume the AudioContext (autoplay policies suspend it pre-gesture). */
  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }
  /** Output gain, 0 to 1 (linear). */
  setVolume(volume) {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }
  /** Current output gain. */
  getVolume() {
    return this.gainNode.gain.value;
  }
  /** Latest v4 jitter snapshot from the worklet, or null before the first. */
  getJitterStats() {
    return this.lastSnapshot ? { ...this.lastSnapshot } : null;
  }
  /** Latest Tap B window (stereo-ness of the rendered output), or null. */
  getTapB() {
    return this.lastTapB ? { ...this.lastTapB } : null;
  }
  /** Channel-count-relevant graph state (stereo diagnostics). */
  getAudioGraphReport() {
    const ctx = this.audioContext;
    const dest = ctx.destination;
    const extCtx = ctx;
    return {
      context: {
        sampleRate: ctx.sampleRate,
        state: ctx.state,
        baseLatencyMs: typeof ctx.baseLatency === "number" ? ctx.baseLatency * 1e3 : null,
        outputLatencyMs: typeof extCtx.outputLatency === "number" ? extCtx.outputLatency * 1e3 : null
      },
      destination: {
        channelCount: dest.channelCount,
        maxChannelCount: dest.maxChannelCount,
        channelCountMode: dest.channelCountMode,
        channelInterpretation: dest.channelInterpretation
      },
      worklet: {
        outputChannelCount: this.opts.channelCount,
        channelCount: this.workletNode.channelCount,
        channelCountMode: this.workletNode.channelCountMode,
        channelInterpretation: this.workletNode.channelInterpretation
      },
      ring: {
        writerFrameSamples: this.opts.writerFrameSamples,
        numChannels: this.opts.channelCount,
        capacityFrames: computeJitterCapacity(this.jbConfigBase).capacity
      }
    };
  }
  /** Stops playout and closes this player's `AudioContext`. Idempotent. */
  async dispose() {
    this.workletNode.port.onmessage = null;
    this.workletNode.onprocessorerror = null;
    try {
      this.workletNode.disconnect();
    } catch {
    }
    this.gainNode.disconnect();
    await this.audioContext.close().catch(() => {
    });
    this.lastSnapshot = null;
    this.lastTapB = null;
  }
  /**
   * One-line [JBUF] observation log — the browser analog of the Go
   * server's [JBUF] tuning line. Gated by `debug`; throttled to ~1/s
   * (the worklet posts stats ~4/s). Filter devtools by "JBUF".
   */
  logJitter(s, fillMin, fillMax) {
    if (!this.opts.debug) return;
    if (this.jbufLogCount++ % 4 !== 0) return;
    const srMs = this.opts.sampleRate / 1e3;
    const swing = fillMin !== void 0 && fillMax !== void 0 ? ` swing=${(fillMin / srMs).toFixed(1)}-${(fillMax / srMs).toFixed(1)}ms` : "";
    console.log(
      `[JBUF] fill=${s.fillMs.toFixed(1)}ms${swing} sp=${s.setpointMs.toFixed(1)} wl=${s.widthLowMs.toFixed(1)} wh=${s.widthHighMs.toFixed(1)} rate=${s.ratePerSec.toFixed(2)}/s${s.frozen ? " FROZEN" : ""} und=${s.underruns} ovr=${s.overruns} lap=${s.laps} trim=${s.trims} ins=${s.samplesInserted} drop=${s.samplesDropped}`
    );
  }
}
async function probeOutputDeviceSampleRate() {
  if (typeof AudioContext === "undefined") return null;
  try {
    const ctx = new AudioContext();
    const rate = ctx.sampleRate;
    await ctx.close();
    return rate;
  } catch {
    return null;
  }
}
function captureCapacityFrames() {
  return 2048;
}
class CaptureRing {
  nc;
  capacity;
  data;
  wpCell;
  rpCell;
  /** Count of quanta dropped because the consumer stalled past capacity (§5.1). */
  overflows;
  constructor(cfg) {
    const nc = cfg.numChannels ?? 1;
    const capacity = cfg.capacityFrames ?? 2048;
    if (nc < 1) {
      throw new Error("CaptureRing: numChannels must be >= 1");
    }
    if (capacity < 1) {
      throw new Error("CaptureRing: capacityFrames must be >= 1");
    }
    if (cfg.sharedStorage.length !== capacity * nc) {
      throw new Error(
        `CaptureRing: sharedStorage length ${cfg.sharedStorage.length} != capacity*nc ${capacity * nc} (allocate capacityFrames * numChannels floats)`
      );
    }
    if (cfg.sharedWritePos.length < 1 || cfg.sharedReadPos.length < 1) {
      throw new Error("CaptureRing: sharedWritePos/sharedReadPos must be length-1 BigInt64Arrays");
    }
    this.nc = nc;
    this.capacity = capacity;
    this.data = cfg.sharedStorage;
    this.wpCell = cfg.sharedWritePos;
    this.rpCell = cfg.sharedReadPos;
    this.overflows = 0;
  }
  /** Cumulative producer position (frames), acquire-loaded. */
  get writePos() {
    return Number(Atomics.load(this.wpCell, 0));
  }
  /** Cumulative consumer position (frames), acquire-loaded. */
  get readPos() {
    return Number(Atomics.load(this.rpCell, 0));
  }
  /** Current fill in frames (unambiguous: positions are cumulative). */
  fillFrames() {
    return this.writePos - this.readPos;
  }
  /**
   * PRODUCER (capture worklet). Interleave one render quantum of planar channels into
   * the ring. `planar[ch]` is a Float32Array of `nFrames` samples (Web Audio is
   * planar; all channels equal length). Channels beyond `planar.length` reuse the last
   * (mono→stereo dup); channels beyond `nc` are ignored. If the consumer has stalled
   * and the quantum would not fit, the WHOLE quantum is dropped and `overflows` is
   * bumped — never blocks, never overwrites unread data (§5.1). Returns true if written.
   */
  write(planar) {
    if (!planar || planar.length === 0 || !planar[0]) {
      return false;
    }
    const nc = this.nc;
    const cap = this.capacity;
    const nFrames = planar[0].length;
    if (nFrames === 0) {
      return false;
    }
    const wp = this.writePos;
    const rp = this.readPos;
    if (wp - rp + nFrames > cap) {
      this.overflows++;
      return false;
    }
    const data = this.data;
    const startFrame = wp % cap;
    for (let i = 0; i < nFrames; i++) {
      const ringBase = (startFrame + i) % cap * nc;
      for (let ch = 0; ch < nc; ch++) {
        const src = planar[ch < planar.length ? ch : planar.length - 1];
        data[ringBase + ch] = src[i];
      }
    }
    Atomics.store(this.wpCell, 0, BigInt(wp + nFrames));
    return true;
  }
  /**
   * CONSUMER (MOQ worker). Copy all whole frames currently available into `dst`
   * (interleaved), up to `dst`'s capacity, then free that space. Returns the number of
   * interleaved SAMPLES written (`frames * nc`), or 0 if nothing was ready. Drain to
   * empty: leaves only what the producer hasn't yet published.
   */
  drain(dst) {
    const nc = this.nc;
    const cap = this.capacity;
    const wp = this.writePos;
    const rp = this.readPos;
    const avail = wp - rp;
    const room = Math.floor(dst.length / nc);
    const nFrames = avail < room ? avail : room;
    if (nFrames <= 0) {
      return 0;
    }
    const data = this.data;
    const startFrame = rp % cap;
    if (startFrame + nFrames <= cap) {
      dst.set(data.subarray(startFrame * nc, (startFrame + nFrames) * nc));
    } else {
      const first = cap - startFrame;
      dst.set(data.subarray(startFrame * nc, cap * nc), 0);
      dst.set(data.subarray(0, (nFrames - first) * nc), first * nc);
    }
    Atomics.store(this.rpCell, 0, BigInt(rp + nFrames));
    return nFrames * nc;
  }
}
const CAPTURE_PROCESSOR_NAME = "capture-processor";
const CAPTURE_PROCESSOR_SOURCE = `
class CaptureRingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.signal = opts.signal;
    // An active processor is never collected (Web Audio §"processor
    // lifetime"), so dispose() sends 'stop' and process() returns false
    // once, which lets the node and this ring's SAB views go.
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e && e.data && e.data.type === 'stop') this.stopped = true;
    };
    this.ring = new CaptureRing({
      numChannels: opts.numChannels,
      capacityFrames: opts.capacityFrames,
      sharedStorage: opts.sharedStorage,
      sharedWritePos: opts.sharedWritePos,
      sharedReadPos: opts.sharedReadPos,
    });
  }

  // PRODUCER: interleave the input quantum into the ring; wake the worker if we wrote.
  // inputs[0] is the planar input (array of per-channel Float32Arrays); empty when no
  // source is connected. CaptureRing.write guards the empty/overflow cases.
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (input && this.ring.write(input)) {
      // Clock-free wake (design §6.1): bump + notify the signal cell. One bounded
      // futex wake, one waiter (the MOQ worker's Atomics.waitAsync). Real-time-safe:
      // no allocation, no lock, the caller never blocks.
      Atomics.add(this.signal, 0, 1);
      Atomics.notify(this.signal, 0, 1);
    }
    // Overflow watch (debug surface): an overflow means the consumer
    // stalled and a whole quantum was dropped — an upstream audio gap.
    // Posts only on change; a healthy pipeline posts never.
    if (this.ring.overflows !== (this.prevOverflows || 0)) {
      this.prevOverflows = this.ring.overflows;
      this.port.postMessage({ type: 'overflow', overflows: this.ring.overflows });
    }
    return true; // keep the processor alive
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, CaptureRingProcessor);
`;
function buildCaptureWorkletCode() {
  const coreSource = CaptureRing.toString();
  if (!coreSource.startsWith("class")) {
    throw new Error("capture-worklet: CaptureRing.toString() is not a class declaration");
  }
  const helper = /\b__(publicField|privateField|decorateClass|decorateParam|name|esDecorate)\b/.exec(coreSource);
  if (helper) {
    throw new Error(
      `capture-worklet: serialized CaptureRing references the bundler helper "${helper[0]}" — it would be undefined in the worklet. Ensure the build keeps native class output.`
    );
  }
  return `const CaptureRing = ${coreSource};
${CAPTURE_PROCESSOR_SOURCE}`;
}
function createCaptureWorkletUrl() {
  const blob2 = new Blob([buildCaptureWorkletCode()], { type: "application/javascript" });
  return URL.createObjectURL(blob2);
}
const POSE_CELL_BYTES = 8 + 6 * 8;
function allocatePoseCell() {
  const sab = new SharedArrayBuffer(POSE_CELL_BYTES);
  return {
    seq: new Int32Array(sab, 0, 1),
    values: new Float64Array(sab, 8, 6)
  };
}
class PoseCell {
  constructor(views) {
    this.views = views;
    if (views.seq.length < 1 || views.values.length < 6) {
      throw new Error("PoseCell: seq must be length-1 Int32Array, values length-6 Float64Array");
    }
  }
  /**
   * WRITER (main). Publish a pose: odd the counter, write, even it.
   * Single-writer — concurrent writers would corrupt the seqlock.
   */
  write(p) {
    const { seq, values } = this.views;
    Atomics.add(seq, 0, 1);
    values[0] = p.x;
    values[1] = p.y;
    values[2] = p.z;
    values[3] = p.yaw;
    values[4] = p.pitch;
    values[5] = p.roll;
    Atomics.add(seq, 0, 1);
  }
  /**
   * READER (worker). Copy the latest consistent snapshot into `out`.
   * BOUNDED retry: the writer is the main thread, and if it is
   * preempted mid-write the counter stays odd for the whole preemption
   * — an unbounded retry loop would busy-spin the worker (stalling
   * capture, encode, sends AND sink decode) until main resumes. That
   * exact stall was observed live 2026-08-06 as accumulate-then-burst
   * jitter churn while dragging poses. On retry exhaustion `out` is
   * left UNTOUCHED: the caller reuses its previous snapshot, so the
   * packet carries a pose one write staler — harmless under the
   * freshest-wins design, and the next read catches up.
   */
  read(out) {
    const { seq, values } = this.views;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s1 = Atomics.load(seq, 0);
      if ((s1 & 1) === 1) continue;
      const x = values[0];
      const y = values[1];
      const z = values[2];
      const yaw = values[3];
      const pitch = values[4];
      const roll = values[5];
      if (Atomics.load(seq, 0) !== s1) continue;
      out.x = x;
      out.y = y;
      out.z = z;
      out.yaw = yaw;
      out.pitch = pitch;
      out.roll = roll;
      return;
    }
  }
}
const workletLoading = /* @__PURE__ */ new WeakMap();
function ensureCaptureWorklet(ctx) {
  let p = workletLoading.get(ctx);
  if (!p) {
    const url = createCaptureWorkletUrl();
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    p.catch(() => workletLoading.delete(ctx));
    workletLoading.set(ctx, p);
  }
  return p;
}
class CapturePipeline {
  constructor(source, splitter, workletNode, ringViews, poseViews, poseWriter, capacityFrames) {
    this.source = source;
    this.splitter = splitter;
    this.workletNode = workletNode;
    this.ringViews = ringViews;
    this.poseViews = poseViews;
    this.poseWriter = poseWriter;
    this.capacityFrames = capacityFrames;
  }
  /** Quanta dropped by the capture ring (worker stalled) — upstream gaps. */
  overflowCount = 0;
  /**
   * Builds the capture graph for one entity off `source` (any AudioNode
   * — MediaStreamAudioSourceNode for a mic, OscillatorNode in tests,
   * a DAW input channel…). Requires cross-origin isolation.
   */
  static async create(source, options = {}) {
    if (typeof SharedArrayBuffer === "undefined" || globalThis.crossOriginIsolated !== true) {
      throw new MoqClientError(
        "Capture requires cross-origin isolation (crossOriginIsolated) for the SharedArrayBuffer ring",
        "NOT_ISOLATED"
      );
    }
    const ctx = source.context;
    if (ctx.sampleRate !== 48e3) {
      throw new MoqClientError(
        `Capture requires a 48 kHz AudioContext (got ${ctx.sampleRate} Hz): construct it with new AudioContext({ sampleRate: 48000 })`,
        "SAMPLE_RATE"
      );
    }
    const channelIndex = options.channelIndex ?? 0;
    await ensureCaptureWorklet(ctx);
    const capacityFrames = captureCapacityFrames();
    const ringViews = {
      sharedStorage: new Float32Array(new SharedArrayBuffer(capacityFrames * 4)),
      // nc = 1
      sharedWritePos: new BigInt64Array(new SharedArrayBuffer(8)),
      sharedReadPos: new BigInt64Array(new SharedArrayBuffer(8)),
      sharedSignal: new Int32Array(new SharedArrayBuffer(4))
    };
    const poseViews = allocatePoseCell();
    const workletNode = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        numChannels: 1,
        capacityFrames,
        sharedStorage: ringViews.sharedStorage,
        sharedWritePos: ringViews.sharedWritePos,
        sharedReadPos: ringViews.sharedReadPos,
        signal: ringViews.sharedSignal
      }
    });
    const splitter = ctx.createChannelSplitter(Math.max(1, channelIndex + 1));
    source.connect(splitter);
    splitter.connect(workletNode, channelIndex, 0);
    const pipeline = new CapturePipeline(
      source,
      splitter,
      workletNode,
      ringViews,
      poseViews,
      new PoseCell(poseViews),
      capacityFrames
    );
    workletNode.port.onmessage = (e) => {
      const d = e.data;
      if (d?.type === "overflow" && typeof d.overflows === "number") {
        pipeline.overflowCount = d.overflows;
      }
    };
    return pipeline;
  }
  /** Capture-ring overflows so far (each = one dropped quantum = an upstream gap). */
  getOverflows() {
    return this.overflowCount;
  }
  /**
   * Publish the entity's freshest pose (seqlock write — wait-free, safe
   * at any rate: sensor callbacks, rAF, XR frames). The next framed
   * packet carries it.
   */
  setPose(pose) {
    this.poseWriter.write(pose);
  }
  /** The shared cells for the worker's `setCaptureTrack`. */
  getHandoff() {
    return {
      numChannels: 1,
      capacityFrames: this.capacityFrames,
      ...this.ringViews,
      poseSeq: this.poseViews.seq,
      poseValues: this.poseViews.values
    };
  }
  /** Sample rate of the owning context (the encoder must match it). */
  get sampleRate() {
    return this.source.context.sampleRate;
  }
  /** Remove this pipeline's nodes (the caller's source/context survive). */
  dispose() {
    try {
      this.workletNode.port.postMessage({ type: "stop" });
    } catch {
    }
    try {
      this.source.disconnect(this.splitter);
    } catch {
    }
    try {
      this.splitter.disconnect();
    } catch {
    }
    try {
      this.workletNode.disconnect();
    } catch {
    }
  }
}
class EntityPublisher {
  /** @internal Built by LasaClient. */
  constructor(transport, entityId, client) {
    this.transport = transport;
    this.entityId = entityId;
    this.controls = new EntityControls(client, entityId);
  }
  controls;
  /** Silences the pair (this entity, `other`) in both directions (profile §6). */
  mute(other) {
    return this.controls.mute(other);
  }
  unmute(other) {
    return this.controls.unmute(other);
  }
  /** Hear `other` (and the other solo'd entities) only; wins over mutes. */
  solo(other) {
    return this.controls.solo(other);
  }
  unsolo(other) {
    return this.controls.unsolo(other);
  }
  /** Sets one runtime attribute at a dotted path. */
  setAttr(path, value) {
    return this.controls.setAttr(path, value);
  }
  clearAttr(path) {
    return this.controls.clearAttr(path);
  }
  /** Sets several attributes as one group. */
  setAttrs(attrs) {
    return this.controls.setAttrs(attrs);
  }
  /**
   * Sends one mono-object packet on the entity's source track. The
   * worker owns the track's gapless sequence (lasa-core.md §5.1: one
   * counter per track, shared with a running capture on this entity)
   * and attaches the uplink redundancy repeat at the entity's offset;
   * any `redundancy` on `packet` is replaced when that offset is above
   * 0 and passed through as given when it is 0. The packet is
   * structured-cloned at postMessage, so its buffers are immediately
   * reusable. Resolves once handed to the worker, not once sent.
   */
  async publish(packet) {
    this.transport.publish(this.entityId, packet);
  }
}
class LasaClient {
  constructor(transport, spaceId, clientId, debug) {
    this.transport = transport;
    this.spaceId = spaceId;
    this.clientId = clientId;
    this.debug = debug;
    this.session = new WorkerSessionProxy(transport);
    this.space = new SpaceControls(this);
  }
  publishers = /* @__PURE__ */ new Map();
  publisherWaiters = /* @__PURE__ */ new Map();
  subgroups = new SubgroupRouter();
  datagrams = new DatagramRouter();
  session;
  stateSync = null;
  sinkPlayers = /* @__PURE__ */ new Map();
  capturePipelines = /* @__PURE__ */ new Map();
  /** Latest ingress-health report per sink alias (worker posts ~2 s). */
  sinkIngress = /* @__PURE__ */ new Map();
  /**
   * The connection's own entity definitions, by id. The declarations
   * are path-scoped (lasa-core.md §4.2): playSink defaults the playout
   * buffer's quality level from the entity's declared quality. Only
   * ad-hoc entities are known here — a ticket-defined entity's
   * definition rides in the ticket, so its sinks take the interactive
   * default unless the caller passes qualityLevel explicitly.
   */
  entityDefs = /* @__PURE__ */ new Map();
  closing = null;
  // Slots reserved synchronously by playSink/startCapture so two
  // overlapping calls for one entity cannot both pass the "already
  // running" guard while the first is still awaiting (B1).
  sinkStarting = /* @__PURE__ */ new Set();
  captureStarting = /* @__PURE__ */ new Set();
  /**
   * Space-wide base-profile operations — moderation, channel policy,
   * rendering (see {@link SpaceControls}). Role-gated by the server.
   */
  space;
  /**
   * Spawns the MOQ worker, connects, authenticates via the Connection
   * Config, and wires the per-entity publishers as the server
   * subscribes them back.
   */
  static async connect(opts) {
    const transport = WorkerTransport.spawn(createMoqWorker());
    const client = new LasaClient(transport, opts.spaceId, opts.clientId, opts.debug ?? false);
    for (const e of opts.entities ?? []) client.entityDefs.set(e.id, e);
    let connected = false;
    transport.setEvents({
      // The server subscribes our source tracks after SETUP; the worker
      // auto-OKs each and forwards the alias it assigned — that alias IS
      // the entity's publisher handle. (The client state source is
      // handled inside the worker, where its stream lives.)
      onIncomingSubscribe: ({ namespace, trackAlias }) => {
        if (namespace.length === 4 && namespace[1] === "entity" && namespace[3] === "source") {
          client.resolvePublisher(namespace[2], new EntityPublisher(transport, namespace[2], client));
        }
      },
      onDatagram: ({ trackAlias, groupId, objectId, payload }) => {
        client.datagrams.ingest({ trackAlias, groupId, objectId, payload });
      },
      onSubgroupObject: ({ trackAlias, groupId, subgroupId, objectId, payload }) => {
        client.subgroups.ingest(
          { trackAlias, groupId, subgroupId, publisherPriority: 0, endOfGroup: false },
          { objectId, payload }
        );
      },
      onNotice: (n) => {
        if (opts.debug) console.log("[lasa] worker notice:", n.event, n.detail ?? "");
      },
      onSinkIngress: (e) => {
        client.sinkIngress.set(e.trackAlias, {
          received: e.received,
          gapEvents: e.gapEvents,
          lostFrames: e.lostFrames,
          reordered: e.reordered,
          decodeErrors: e.decodeErrors
        });
      },
      onTransportClosed: (e) => {
        if (!connected) return;
        opts.onClosed?.({ closeCode: e.closeCode, reason: e.reason });
      }
    });
    const config = {
      clientId: opts.clientId,
      ticket: opts.ticket,
      entities: opts.entities,
      setups: opts.setups
    };
    try {
      await transport.connect(opts.url, config, opts.serverCertificateHashBase64, opts.debug ?? false);
    } catch (e) {
      await transport.close().catch(() => {
      });
      throw e;
    }
    connected = true;
    return client;
  }
  /**
   * Publishes client-authored state ops on the state source subgroup
   * (upstream layout — no seqs). The worker waits for the server's
   * subscribe of the state source if it has not landed yet.
   */
  async writeState(...msgs) {
    await this.transport.writeState(msgs.map((m) => encodeStateMessage(m, "upstream")));
  }
  /**
   * Runs the state subscription against the store: subscribe with the
   * store's cursor, feed both lanes, re-subscribe with backoff on
   * termination. Returns the running StateSync; runs until stop() or
   * close(). All store access from the caller should await
   * sync.settled() first.
   */
  syncState(store, opts = {}) {
    if (this.stateSync) return this.stateSync;
    const sync = new StateSync(this.session, this.subgroups, this.spaceId, this.clientId, store, {
      debug: this.debug,
      ...opts
    });
    this.stateSync = sync;
    void sync.run();
    return sync;
  }
  resolvePublisher(entityId, pub) {
    this.publishers.set(entityId, pub);
    const waiters = this.publisherWaiters.get(entityId);
    if (waiters) {
      this.publisherWaiters.delete(entityId);
      for (const w of waiters) w.resolve(pub);
    }
  }
  /**
   * Owner-scope base-profile controls for one of this connection's
   * entities, without waiting for its publisher. The same operations
   * are on {@link EntityPublisher}.
   */
  controls(entityId) {
    return new EntityControls(this, entityId);
  }
  /**
   * The entity's publisher; resolves when the server has subscribed
   * the entity's source track (normally within the first RTTs).
   */
  entity(entityId, timeoutMs = 5e3) {
    const existing = this.publishers.get(entityId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      };
      const timer = setTimeout(() => {
        const list2 = this.publisherWaiters.get(entityId);
        if (list2) {
          const i = list2.indexOf(waiter);
          if (i >= 0) list2.splice(i, 1);
          if (list2.length === 0) this.publisherWaiters.delete(entityId);
        }
        reject(new Error(`server did not subscribe entity ${entityId} source in ${timeoutMs}ms`));
      }, timeoutMs);
      const list = this.publisherWaiters.get(entityId) ?? [];
      list.push(waiter);
      this.publisherWaiters.set(entityId, list);
    });
  }
  /**
   * Subscribes an entity's sink track and plays it through the 3-thread
   * playout path: worker decode → SAB jitter ring → playout worklet.
   * Main never touches the audio. Returns the SinkPlayer (volume,
   * jitter stats, Tap B); call {@link stopSink} or close() to end it.
   * One player per entity sink (multi-entity: call per entity).
   */
  async playSink(entityId, format, opts = {}) {
    if (this.sinkPlayers.has(entityId) || this.sinkStarting.has(entityId)) {
      throw new Error(`sink for entity ${entityId} is already playing`);
    }
    this.sinkStarting.add(entityId);
    try {
      return await this.playSinkInner(entityId, format, opts);
    } finally {
      this.sinkStarting.delete(entityId);
    }
  }
  async playSinkInner(entityId, format, opts) {
    const def = this.entityDefs.get(entityId);
    const player = await SinkPlayer.create({
      debug: this.debug,
      ...def?.quality !== void 0 ? { qualityLevel: def.quality } : {},
      ...def?.redundancy !== void 0 ? { redundancy: def.redundancy } : {},
      ...opts
    });
    try {
      const { trackAlias } = await this.transport.subscribe(
        entityNamespace(this.spaceId, entityId, "sink"),
        format
      );
      const ring = player.getRingHandoff();
      await this.transport.setSinkTrack(
        trackAlias,
        player.getDecoderConfig(),
        ring.jbufConfig,
        ring.sharedStorage,
        ring.sharedWritePos,
        ring.redundancy
      );
      this.sinkPlayers.set(entityId, { player, trackAlias });
      await player.resume();
      return player;
    } catch (e) {
      await player.dispose().catch(() => {
      });
      throw e;
    }
  }
  /**
   * Starts an entity's capture: any AudioNode (mic source, oscillator,
   * DAW channel) feeds a mono pipeline — worklet → SAB ring → worker
   * Opus encode → mono-object datagrams stamped with the FRESHEST pose
   * from the shared cell (update it via {@link CaptureHandle.setPose}).
   * Per-entity: call once per publishing entity, sharing one context.
   *
   * The source's AudioContext MUST run at 48 kHz (lasa-core.md §5: Opus,
   * 48 kHz, 5 ms) — construct it with `new AudioContext({ sampleRate:
   * 48000 })`; any other rate is refused. Frames are always 5 ms.
   */
  async startCapture(entityId, opts) {
    if (this.capturePipelines.has(entityId) || this.captureStarting.has(entityId)) {
      throw new Error(`capture for entity ${entityId} is already running`);
    }
    this.captureStarting.add(entityId);
    try {
      return await this.startCaptureInner(entityId, opts);
    } finally {
      this.captureStarting.delete(entityId);
    }
  }
  async startCaptureInner(entityId, opts) {
    if (opts.redundancy !== void 0) {
      if (!Number.isInteger(opts.redundancy) || opts.redundancy < 0 || opts.redundancy > 7) {
        throw new RangeError(`redundancy ${opts.redundancy} outside 0-7`);
      }
      const declared = this.entityDefs.get(entityId)?.redundancy;
      if (declared !== void 0 && opts.redundancy > declared) {
        throw new RangeError(`redundancy ${opts.redundancy} above the entity's declaration ${declared}`);
      }
    }
    const pipeline = await CapturePipeline.create(opts.source, { channelIndex: opts.channelIndex });
    try {
      await this.transport.setCaptureTrack(entityId, pipeline.getHandoff(), {
        codec: "opus",
        sampleRate: pipeline.sampleRate,
        numberOfChannels: 1,
        bitrate: opts.bitrate ?? 64e3,
        // The LASA frame is 5 ms, always (lasa-core.md §5): the server
        // extends timestamps by seq × 5 ms and redundancy offsets are
        // multiples of it. Not a caller option.
        frameDurationUs: 5e3,
        ...opts.redundancy !== void 0 ? { redundancy: opts.redundancy } : {}
      });
    } catch (e) {
      pipeline.dispose();
      throw e;
    }
    this.capturePipelines.set(entityId, pipeline);
    if (opts.pose) pipeline.setPose(opts.pose);
    return {
      setPose: (pose) => pipeline.setPose(pose),
      stop: () => this.stopCapture(entityId)
    };
  }
  /** Capture-ring overflows for a capturing entity (each = a dropped quantum = an upstream gap), or null. */
  getCaptureOverflows(entityId) {
    return this.capturePipelines.get(entityId)?.getOverflows() ?? null;
  }
  /** Stops an entity's capture: flushes the worker encoder, removes the graph nodes. */
  async stopCapture(entityId) {
    const pipeline = this.capturePipelines.get(entityId);
    if (!pipeline) return;
    this.capturePipelines.delete(entityId);
    await this.transport.stopCapture(entityId).catch(() => {
    });
    pipeline.dispose();
  }
  /** Stops a playing sink: worker decode ends, then the graph tears down. */
  async stopSink(entityId) {
    const entry = this.sinkPlayers.get(entityId);
    if (!entry) return;
    this.sinkPlayers.delete(entityId);
    this.sinkIngress.delete(entry.trackAlias);
    await this.transport.clearSinkTrack(entry.trackAlias).catch(() => {
    });
    await entry.player.dispose();
  }
  /**
   * Latest ingress health for a playing sink (updated ~2 s by the
   * worker), or null before the first report. Distinguishes network
   * damage (gaps/loss/reorder — clicks that are NOT the jitter
   * buffer's) from buffer behaviour (the player's getEvents()).
   */
  getSinkIngress(entityId) {
    const entry = this.sinkPlayers.get(entityId);
    if (!entry) return null;
    return this.sinkIngress.get(entry.trackAlias) ?? null;
  }
  /** Subscribes an entity's sink track (own-or-granted per §3.1/§2). */
  async subscribeSink(entityId, format, handler) {
    const { trackAlias } = await this.transport.subscribe(
      entityNamespace(this.spaceId, entityId, "sink"),
      format
    );
    this.datagrams.register(trackAlias, (payload, _alias, groupId) => {
      let pkt;
      try {
        pkt = parseSink(payload);
      } catch {
        return;
      }
      handler(groupId, pkt);
    });
  }
  /**
   * Subscribes the space presence track. The handler receives each
   * packet's datagram group-id — part of the §7 receive contract
   * (per-index latest-wins). Most consumers want subscribeRoster,
   * which applies the §7 rules once and maintains the roster.
   */
  async subscribePresence(handler) {
    const { trackAlias } = await this.transport.subscribe(presenceNamespace(this.spaceId), "presence");
    this.datagrams.register(trackAlias, (payload, _alias, groupId) => {
      let msg;
      try {
        msg = parsePresence(payload);
      } catch {
        return;
      }
      handler(groupId, msg);
    });
  }
  /**
   * Subscribes presence and maintains a PresenceRoster from it — the
   * §7 client rules (generation discard, per-index latest-wins, reset
   * on generation change) applied in the SDK.
   */
  async subscribeRoster(onUpdate) {
    const roster = new PresenceRoster();
    if (onUpdate) roster.onUpdate = onUpdate;
    await this.subscribePresence((groupId, msg) => roster.apply(groupId, msg));
    return roster;
  }
  /**
   * Ends the session: stops every capture and sink, stops the state
   * sync, and tears down the worker and transport. Idempotent.
   */
  async close() {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    this.stateSync?.stop();
    for (const [, pipeline] of this.capturePipelines) {
      pipeline.dispose();
    }
    this.capturePipelines.clear();
    for (const [, { player }] of this.sinkPlayers) {
      await player.dispose().catch(() => {
      });
    }
    this.sinkPlayers.clear();
    this.sinkIngress.clear();
    this.datagrams.clear();
    const waiters = [...this.publisherWaiters.values()].flat();
    this.publisherWaiters.clear();
    for (const w of waiters) w.reject(new Error("client closed"));
    await this.transport.close();
  }
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function radiansToDegrees(rad) {
  return rad / Math.PI * 180;
}
function degreesToRadians(deg) {
  return deg / 180 * Math.PI;
}
function eulerToQuaternion(ex, ey, ez, order) {
  const c1 = Math.cos(ex / 2);
  const c2 = Math.cos(ey / 2);
  const c3 = Math.cos(ez / 2);
  const s1 = Math.sin(ex / 2);
  const s2 = Math.sin(ey / 2);
  const s3 = Math.sin(ez / 2);
  switch (order) {
    case "XYZ":
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3
      };
    case "YXZ":
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3
      };
    case "ZXY":
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3
      };
    case "ZYX":
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3
      };
    case "YZX":
      return {
        x: s1 * c2 * c3 + c1 * s2 * s3,
        y: c1 * s2 * c3 + s1 * c2 * s3,
        z: c1 * c2 * s3 - s1 * s2 * c3,
        w: c1 * c2 * c3 - s1 * s2 * s3
      };
    case "XZY":
      return {
        x: s1 * c2 * c3 - c1 * s2 * s3,
        y: c1 * s2 * c3 - s1 * c2 * s3,
        z: c1 * c2 * s3 + s1 * s2 * c3,
        w: c1 * c2 * c3 + s1 * s2 * s3
      };
    default:
      throw new Error(`Unknown Euler order: ${order}`);
  }
}
function quaternionToMatrix(q) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz),
    xy + wz,
    xz - wy,
    0,
    xy - wz,
    1 - (xx + zz),
    yz + wx,
    0,
    xz + wy,
    yz - wx,
    1 - (xx + yy),
    0,
    0,
    0,
    0,
    1
  ];
}
function matrixToEuler(te, order) {
  const m11 = te[0], m12 = te[4], m13 = te[8];
  const m21 = te[1], m22 = te[5], m23 = te[9];
  const m31 = te[2], m32 = te[6], m33 = te[10];
  switch (order) {
    case "XYZ": {
      const sy = clamp(m13, -1, 1);
      const ey = Math.asin(sy);
      if (Math.abs(sy) < 0.9999999) {
        return { x: Math.atan2(-m23, m33), y: ey, z: Math.atan2(-m12, m11) };
      } else {
        return { x: Math.atan2(m32, m22), y: ey, z: 0 };
      }
    }
    case "YXZ": {
      const sx = clamp(m23, -1, 1);
      const ex = Math.asin(-sx);
      if (Math.abs(sx) < 0.9999999) {
        return { x: ex, y: Math.atan2(m13, m33), z: Math.atan2(m21, m22) };
      } else {
        return { x: ex, y: Math.atan2(-m31, m11), z: 0 };
      }
    }
    case "ZXY": {
      const sx = clamp(m32, -1, 1);
      const ex = Math.asin(sx);
      if (Math.abs(sx) < 0.9999999) {
        return { x: ex, y: Math.atan2(-m31, m33), z: Math.atan2(-m12, m22) };
      } else {
        return { x: ex, y: 0, z: Math.atan2(m21, m11) };
      }
    }
    case "ZYX": {
      const sy = clamp(m31, -1, 1);
      const ey = Math.asin(-sy);
      if (Math.abs(sy) < 0.9999999) {
        return { x: Math.atan2(m32, m33), y: ey, z: Math.atan2(m21, m11) };
      } else {
        return { x: 0, y: ey, z: Math.atan2(-m12, m22) };
      }
    }
    case "YZX": {
      const sz = clamp(m21, -1, 1);
      const ez = Math.asin(sz);
      if (Math.abs(sz) < 0.9999999) {
        return { x: Math.atan2(-m23, m22), y: Math.atan2(-m31, m11), z: ez };
      } else {
        return { x: 0, y: Math.atan2(m13, m33), z: ez };
      }
    }
    case "XZY": {
      const sz = clamp(m12, -1, 1);
      const ez = Math.asin(-sz);
      if (Math.abs(sz) < 0.9999999) {
        return { x: Math.atan2(m32, m22), y: Math.atan2(m13, m11), z: ez };
      } else {
        return { x: Math.atan2(-m23, m33), y: 0, z: ez };
      }
    }
    default:
      throw new Error(`Unknown Euler order: ${order}`);
  }
}
function quaternionToEuler(q, order) {
  const m = quaternionToMatrix(q);
  return matrixToEuler(m, order);
}
const TWO_PI = 2 * Math.PI;
function wrapAngle(a) {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}
function makePose(pos, rot) {
  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    yaw: wrapAngle(rot.yaw),
    pitch: wrapAngle(rot.pitch),
    roll: wrapAngle(rot.roll)
  };
}
function webglPositionToLasa(pos) {
  return { x: -pos.z, y: -pos.x, z: pos.y };
}
function lasaPositionToWebgl(pose) {
  return { x: -pose.y, y: pose.z, z: -pose.x };
}
function webglQuatToLasaRotation(q) {
  const euler = quaternionToEuler(q, "YXZ");
  return { yaw: euler.y, pitch: euler.x, roll: euler.z };
}
function lasaRotationToWebglQuat(pose) {
  return eulerToQuaternion(pose.pitch, pose.yaw, pose.roll, "YXZ");
}
function lhYupQuatToWebgl(q) {
  return { x: -q.x, y: -q.y, z: q.z, w: q.w };
}
function webglQuatToLhYup(q) {
  return { x: -q.x, y: -q.y, z: q.z, w: q.w };
}
function unrealQuatToWebgl(q) {
  return { x: -q.y, y: -q.z, z: q.x, w: q.w };
}
function webglQuatToUnreal(q) {
  return { x: q.z, y: -q.x, z: -q.y, w: q.w };
}
function threejsToLasa(position, rotation, order = "XYZ") {
  const q = eulerToQuaternion(rotation.x, rotation.y, rotation.z, order);
  return makePose(webglPositionToLasa(position), webglQuatToLasaRotation(q));
}
function lasaToThreejs(pose, order = "XYZ") {
  const q = lasaRotationToWebglQuat(pose);
  const euler = quaternionToEuler(q, order);
  return {
    position: lasaPositionToWebgl(pose),
    rotation: { x: euler.x, y: euler.y, z: euler.z }
  };
}
function babylonToLasa(position, rotation) {
  const webglPos = { x: position.x, y: position.y, z: -position.z };
  const qBab = eulerToQuaternion(rotation.x, rotation.y, rotation.z, "YXZ");
  const qWebgl = lhYupQuatToWebgl(qBab);
  return makePose(webglPositionToLasa(webglPos), webglQuatToLasaRotation(qWebgl));
}
function lasaToBabylon(pose) {
  const webglPos = lasaPositionToWebgl(pose);
  const qWebgl = lasaRotationToWebglQuat(pose);
  const qBab = webglQuatToLhYup(qWebgl);
  const euler = quaternionToEuler(qBab, "YXZ");
  return {
    position: { x: webglPos.x, y: webglPos.y, z: -webglPos.z },
    rotation: { x: euler.x, y: euler.y, z: euler.z }
  };
}
function aframeToLasa(position, rotation) {
  return makePose(webglPositionToLasa(position), {
    yaw: degreesToRadians(rotation.y),
    pitch: degreesToRadians(rotation.x),
    roll: degreesToRadians(rotation.z)
  });
}
function lasaToAframe(pose) {
  return {
    position: lasaPositionToWebgl(pose),
    rotation: {
      x: radiansToDegrees(pose.pitch),
      y: radiansToDegrees(pose.yaw),
      z: radiansToDegrees(pose.roll)
    }
  };
}
function playcanvasToLasa(position, rotation) {
  const q = eulerToQuaternion(
    degreesToRadians(rotation.x),
    degreesToRadians(rotation.y),
    degreesToRadians(rotation.z),
    "ZYX"
  );
  return makePose(webglPositionToLasa(position), webglQuatToLasaRotation(q));
}
function lasaToPlaycanvas(pose) {
  const q = lasaRotationToWebglQuat(pose);
  const euler = quaternionToEuler(q, "ZYX");
  return {
    position: lasaPositionToWebgl(pose),
    rotation: {
      x: radiansToDegrees(euler.x),
      y: radiansToDegrees(euler.y),
      z: radiansToDegrees(euler.z)
    }
  };
}
function unityToLasa(position, rotation) {
  return babylonToLasa(position, {
    x: degreesToRadians(rotation.x),
    y: degreesToRadians(rotation.y),
    z: degreesToRadians(rotation.z)
  });
}
function lasaToUnity(pose) {
  const bab = lasaToBabylon(pose);
  return {
    position: bab.position,
    rotation: {
      x: radiansToDegrees(bab.rotation.x),
      y: radiansToDegrees(bab.rotation.y),
      z: radiansToDegrees(bab.rotation.z)
    }
  };
}
function unrealToLasa(position, rotation) {
  const pos = { x: position.x, y: -position.y, z: position.z };
  const qUe = eulerToQuaternion(
    degreesToRadians(-rotation.roll),
    degreesToRadians(-rotation.pitch),
    degreesToRadians(rotation.yaw),
    "ZYX"
  );
  const qWebgl = unrealQuatToWebgl(qUe);
  return makePose(pos, webglQuatToLasaRotation(qWebgl));
}
function lasaToUnreal(pose) {
  const qWebgl = lasaRotationToWebglQuat(pose);
  const qUe = webglQuatToUnreal(qWebgl);
  const euler = quaternionToEuler(qUe, "ZYX");
  return {
    position: { x: pose.x, y: -pose.y, z: pose.z },
    rotation: {
      roll: radiansToDegrees(-euler.x),
      pitch: radiansToDegrees(-euler.y),
      yaw: radiansToDegrees(euler.z)
    }
  };
}
function pixiToLasa(position, rotation) {
  return makePose(
    { x: -position.y, y: -position.x, z: 0 },
    { yaw: -rotation, pitch: 0, roll: 0 }
  );
}
function lasaToPixi(pose) {
  return {
    position: { x: -pose.y, y: -pose.x },
    rotation: -pose.yaw
  };
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
class Store {
  constructor(prefixes, prefixSetHash, clock) {
    this.prefixes = prefixes;
    this.prefixSetHash = prefixSetHash;
    this.clock = clock;
  }
  entries = /* @__PURE__ */ new Map();
  cursor = null;
  // eligible: the first catch-up frontier of the current subscription
  // instance has been applied (invariant F7); until then no cursor may
  // be advanced.
  eligible = false;
  // Catch-up window state (transient-tombstone strategy).
  inWindow = false;
  windowKind = "delta";
  windowStart = 0;
  transient = null;
  // key → live clear seq
  snapshotIn = null;
  // keys delivered by the current snapshot
  liveMaxSeq = 0n;
  epoch = null;
  /**
   * Creates an empty store for one prefix set. The set is
   * canonicalized. Async: the set-hash needs WebCrypto. A store belongs
   * to one space — its cursor is meaningless anywhere else.
   */
  static async create(prefixes, opts = {}) {
    const canon = canonicalPrefixes(prefixes);
    return new Store(canon, await setHash(canon), opts.clock ?? (() => Date.now()));
  }
  /**
   * The subscribe inputs for a (re)connection: the prefix set plus the
   * cursor earned so far, if any.
   */
  subscribeParams() {
    return { prefixes: this.prefixes, ...this.cursor ? { cursor: this.cursor } : {} };
  }
  /** The latest value for `key`, or undefined. */
  get(key) {
    return this.entries.get(key)?.value;
  }
  /** Number of keys held. */
  get size() {
    return this.entries.size;
  }
  /** Iterates every live key. */
  *[Symbol.iterator]() {
    yield* this.entries;
  }
  /**
   * Applies one live-lane message. Live ops apply immediately under
   * per-key dedup; during the catch-up window every live clear —
   * including for keys not held — is recorded as a transient tombstone
   * so a late catch-up chunk cannot resurrect it (lasa-core.md §6.5).
   */
  async applyLive(m) {
    switch (m.kind) {
      case "set":
        this.liveSet(m);
        return;
      case "clear":
        this.liveClear(m);
        return;
      case "group":
        for (const op of m.ops) await this.applyLive(op);
        return;
      case "frontier":
        this.setEpoch(m.epoch);
        if (m.seq > this.liveMaxSeq) this.liveMaxSeq = m.seq;
        this.advanceCursor();
        return;
      default:
        throw new MalformedError(`unexpected live message ${m.kind}`);
    }
  }
  liveSet(v) {
    const kv = this.entries.get(v.key);
    if (kv && v.seq <= kv.seq) return;
    if (this.inWindow && (this.transient.get(v.key) ?? -1n) >= v.seq) return;
    this.entries.set(v.key, { value: v.value, seq: v.seq });
  }
  liveClear(v) {
    const kv = this.entries.get(v.key);
    if (kv && v.seq <= kv.seq) return;
    this.entries.delete(v.key);
    if (this.inWindow) this.transient.set(v.key, v.seq);
  }
  /**
   * Applies one catch-up-lane message: Begin opens the window, entries
   * stream lazily, and the closing Frontier finalizes — running the
   * snapshot deletion rule, dropping the transient records, and earning
   * the cursor (invariant F7).
   */
  async applyCatchUp(m) {
    switch (m.kind) {
      case "begin":
        this.inWindow = true;
        this.windowKind = m.begin;
        this.windowStart = this.clock();
        this.transient = /* @__PURE__ */ new Map();
        this.snapshotIn = /* @__PURE__ */ new Set();
        return;
      case "set": {
        if (!this.inWindow) throw new MalformedError("catch-up entry before begin");
        if (this.windowKind === "snapshot") this.snapshotIn.add(m.key);
        if ((this.transient.get(m.key) ?? -1n) >= m.seq) return;
        const kv = this.entries.get(m.key);
        if (kv && m.seq <= kv.seq) return;
        this.entries.set(m.key, { value: m.value, seq: m.seq });
        return;
      }
      case "clear": {
        if (!this.inWindow) throw new MalformedError("catch-up entry before begin");
        const kv = this.entries.get(m.key);
        if (kv && m.seq > kv.seq) this.entries.delete(m.key);
        return;
      }
      case "frontier": {
        if (!this.inWindow) throw new MalformedError("catch-up frontier before begin");
        this.setEpoch(m.epoch);
        if (this.windowKind === "snapshot") {
          for (const [k, kv] of this.entries) {
            if (!this.snapshotIn.has(k) && kv.seq <= m.seq) this.entries.delete(k);
          }
        }
        this.inWindow = false;
        this.transient = null;
        this.snapshotIn = null;
        this.eligible = true;
        if (m.seq > this.liveMaxSeq) this.liveMaxSeq = m.seq;
        this.advanceCursor();
        return;
      }
      default:
        throw new MalformedError(`unexpected catch-up message ${m.kind}`);
    }
  }
  setEpoch(e) {
    if (!this.epoch || !bytesEqual(this.epoch, e)) {
      if (this.epoch && this.cursor && !bytesEqual(this.cursor.epoch, e)) {
        this.cursor = null;
      }
      this.epoch = e.slice();
    }
  }
  // Moves the cursor to the max seq seen across both paths — only once
  // eligible (invariant F7), and only within the current epoch.
  advanceCursor() {
    if (!this.eligible || !this.epoch) return;
    if (!this.cursor || !bytesEqual(this.cursor.epoch, this.epoch) || this.liveMaxSeq > this.cursor.seq) {
      this.cursor = { epoch: this.epoch.slice(), seq: this.liveMaxSeq, setHash: this.prefixSetHash };
    }
  }
  /**
   * Informs the store its subscription instance ended (too-far-behind,
   * displacement, transport close). The catch-up window state —
   * including the transient records, which belong to the dead instance
   * — is discarded; eligibility resets so the next instance must earn
   * its own frontier before any cursor advances again.
   */
  terminated() {
    this.inWindow = false;
    this.transient = null;
    this.snapshotIn = null;
    this.eligible = false;
    this.liveMaxSeq = 0n;
  }
  /**
   * Whether a catch-up window has been open longer than deadlineMs —
   * the cue to unsubscribe and re-subscribe fresh rather than hold a
   * transient-record window forever.
   */
  catchUpStalled(deadlineMs) {
    return this.inWindow && this.clock() - this.windowStart > deadlineMs;
  }
}
const BLUETOOTH_KEYWORDS = [
  "bluetooth",
  "bt ",
  "bt-",
  // HFP/SCO profile indicators (sometimes exposed in device labels)
  "hands-free",
  "handsfree",
  "hfp",
  "sco",
  "a2dp"
];
const BLUETOOTH_BRANDS = [
  "airpods",
  "beats ",
  "beats+",
  "beatsx",
  "powerbeats",
  "jabra",
  "galaxy buds",
  "buds pro",
  "buds live",
  "buds2",
  "buds fe",
  "sony wh-",
  "sony wf-",
  "bose qc",
  "bose quietcomfort",
  "bose noise cancelling",
  "bose soundsport",
  "bose sport",
  "jbl tune",
  "jbl live",
  "jbl reflect",
  "jbl endurance",
  "sennheiser momentum",
  "sennheiser cx",
  "marshall major",
  "marshall minor",
  "marshall motif",
  "pixel buds",
  "nothing ear",
  "huawei freebuds",
  "oppo enco",
  "oneplus buds",
  "anker soundcore",
  "soundcore liberty",
  "skullcandy",
  "tozo",
  "jlab"
];
const USB_KEYWORDS = [
  "usb",
  // Well-known USB mic brands
  "blue yeti",
  "blue snowball",
  "rode nt-usb",
  "rode podcaster",
  "at2020",
  "at2005",
  "samson",
  "focusrite",
  "scarlett",
  "behringer",
  "presonus",
  "elgato wave",
  "hyperx quadcast",
  "razer seiren",
  "fifine",
  "maono",
  "audio-technica",
  "shure mv"
];
const BUILTIN_KEYWORDS = [
  "built-in",
  "builtin",
  "internal",
  "macbook",
  "imac",
  "integrated",
  "laptop",
  "webcam",
  "facetime"
];
function classifyByLabel(label) {
  const lower = label.toLowerCase();
  for (const keyword of BLUETOOTH_KEYWORDS) {
    if (lower.includes(keyword)) return "bluetooth";
  }
  for (const brand of BLUETOOTH_BRANDS) {
    if (lower.includes(brand)) return "bluetooth";
  }
  for (const keyword of USB_KEYWORDS) {
    if (lower.includes(keyword)) return "usb";
  }
  for (const keyword of BUILTIN_KEYWORDS) {
    if (lower.includes(keyword)) return "builtin";
  }
  return "unknown";
}
const TYPE_PRIORITY = {
  usb: 0,
  builtin: 1,
  unknown: 2,
  bluetooth: 3
};
function compareMicrophones(a, b) {
  return TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
}
async function micPermissionGranted() {
  try {
    const permissions = navigator.permissions;
    if (!permissions?.query) return inputLabelsReadable();
    const status = await permissions.query({ name: "microphone" });
    return status.state === "granted";
  } catch {
    return inputLabelsReadable();
  }
}
async function inputLabelsReadable() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === "audioinput" && d.label !== "");
  } catch {
    return false;
  }
}
async function selectBestMicrophone(debug = false) {
  const log = debug ? (...args) => console.log("[MicSelection]", ...args) : () => {
  };
  if (!await micPermissionGranted()) {
    log("Mic permission not granted — no labels readable; deferring to the system default");
    return {
      deviceId: void 0,
      label: "(permission pending)",
      type: "unknown",
      allDevices: [],
      switchedFromBluetooth: false,
      permissionPending: true
    };
  }
  const allDevices = await navigator.mediaDevices.enumerateDevices();
  const mics = allDevices.filter((d) => d.kind === "audioinput").map((d) => ({
    deviceId: d.deviceId,
    label: d.label || "(unlabelled)",
    type: classifyByLabel(d.label || "")
  }));
  log("Enumerated microphones:", mics.map((m) => `${m.label} [${m.type}]`));
  if (mics.length === 0) {
    log("No microphones found, using system default");
    return {
      deviceId: void 0,
      label: "(none)",
      type: "unknown",
      allDevices: [],
      switchedFromBluetooth: false,
      permissionPending: false
    };
  }
  const defaultMic = mics[0];
  const defaultIsBluetooth = defaultMic.type === "bluetooth";
  const ranked = [...mics].sort(compareMicrophones);
  const best = ranked[0];
  log("Ranked microphones:", ranked.map((m) => `${m.label} [${m.type}]`));
  log(`Selected: ${best.label} [${best.type}]`);
  if (defaultIsBluetooth && best.type !== "bluetooth") {
    log(`Switched away from Bluetooth default: ${defaultMic.label}`);
  }
  return {
    deviceId: best.deviceId === "default" ? void 0 : best.deviceId,
    label: best.label,
    type: best.type,
    allDevices: mics,
    switchedFromBluetooth: defaultIsBluetooth && best.type !== "bluetooth",
    permissionPending: false
  };
}
export {
  BASE_PREFIX,
  BaseView,
  CapturePipeline,
  EntityControls,
  EntityPublisher,
  LASA_ERR,
  LOUDNESS_SILENT,
  LasaClient,
  LasaRejectionError,
  MalformedError,
  PresenceRoster,
  SinkPlayer,
  SpaceControls,
  StateSync,
  Store,
  TRACK_AMBI2,
  TRACK_AMBI3,
  TRACK_BINAURAL,
  TRACK_MONO_OBJECT,
  TRACK_PRESENCE,
  TRACK_STATE,
  UnknownFlagsError,
  aframeToLasa,
  babylonToLasa,
  keys as baseKeys,
  baseView,
  classifyByLabel,
  decodeValue,
  encodeValue,
  isIdentifier,
  isLasaRejectionCode,
  lasaErrorName,
  lasaToAframe,
  lasaToBabylon,
  lasaToPixi,
  lasaToPlaycanvas,
  lasaToThreejs,
  lasaToUnity,
  lasaToUnreal,
  loudnessToDBFS,
  micPermissionGranted,
  pixiToLasa,
  playcanvasToLasa,
  probeOutputDeviceSampleRate,
  selectBestMicrophone,
  threejsToLasa,
  unityToLasa,
  unrealToLasa
};
