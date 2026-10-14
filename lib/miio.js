'use strict';

/**
 * Minimal client for Xiaomi's local miIO protocol (UDP port 54321).
 *
 * Every packet has a 32-byte header - magic 0x2131, total length, 4 unused
 * bytes, the device id, a timestamp and an MD5 checksum - followed by a JSON
 * payload encrypted with AES-128-CBC. The key is MD5(token) and the IV is
 * MD5(key + token). The checksum is the MD5 of the header (with the token in
 * the checksum slot) plus the encrypted payload.
 *
 * Before the first command, and whenever the device stops answering, the
 * client sends a "hello" packet. The reply carries the device id and the
 * device's own clock, which every later packet has to echo back roughly in
 * step, or the device silently drops it.
 */

const crypto = require('crypto');
const dgram = require('dgram');

const PORT = 54321;
const HEADER_LENGTH = 32;
const MAGIC = 0x2131;
const HELLO = Buffer.from(`21310020${'ff'.repeat(28)}`, 'hex');

// Devices forget the session after a couple of minutes of silence; re-handshake
// well before that rather than lose a command to it.
const HANDSHAKE_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 2;
// A device ignores a request id it has answered recently, so a retry needs a new
// one. Jumping by a large step also clears ids left over from a previous run.
const RETRY_ID_STEP = 100;
const MAX_REQUEST_ID = 0x7fffffff;

class MiioError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MiioError';
    this.code = code;
  }
}

class MiioTimeoutError extends MiioError {
  constructor(message) {
    super(message, 'ETIMEDOUT');
    this.name = 'MiioTimeoutError';
  }
}

function md5(...parts) {
  const hash = crypto.createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function parseToken(token) {
  const text = String(token || '').trim();
  if (!/^[0-9a-fA-F]{32}$/.test(text)) {
    throw new MiioError('The token must be 32 hexadecimal characters', 'EINVALIDTOKEN');
  }
  return Buffer.from(text, 'hex');
}

function cipherFor(token) {
  const key = md5(token);
  const iv = md5(key, token);
  return { key, iv };
}

function encrypt(token, plaintext) {
  const { key, iv } = cipherFor(token);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decrypt(token, ciphertext) {
  const { key, iv } = cipherFor(token);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Build an encrypted packet carrying `payload` (an object, sent as JSON).
 */
function encodePacket({ token, deviceId, stamp, payload }) {
  const data = encrypt(token, Buffer.from(JSON.stringify(payload), 'utf8'));
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt16BE(HEADER_LENGTH + data.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  token.copy(header, 16);
  md5(header, data).copy(header, 16);
  return Buffer.concat([header, data]);
}

/**
 * Parse a packet. Returns `{ deviceId, stamp, payload }`, where payload is the
 * decoded JSON object, or null for a bare 32-byte handshake reply.
 * Pass `token: null` to read only the header.
 */
function decodePacket(packet, token) {
  if (packet.length < HEADER_LENGTH || packet.readUInt16BE(0) !== MAGIC) {
    throw new MiioError('Not a miIO packet', 'EBADPACKET');
  }
  const length = packet.readUInt16BE(2);
  if (length > packet.length) {
    throw new MiioError('Truncated miIO packet', 'EBADPACKET');
  }
  const deviceId = packet.readUInt32BE(8);
  const stamp = packet.readUInt32BE(12);
  if (length === HEADER_LENGTH || !token) {
    return { deviceId, stamp, payload: null, checksum: packet.subarray(16, 32) };
  }

  const data = packet.subarray(HEADER_LENGTH, length);
  const expected = md5(packet.subarray(0, 16), token, data);
  if (!expected.equals(packet.subarray(16, 32))) {
    throw new MiioError('Checksum mismatch - the token is probably wrong', 'ECHECKSUM');
  }

  let text;
  try {
    text = decrypt(token, data).toString('utf8');
  } catch (err) {
    throw new MiioError('Could not decrypt the reply - the token is probably wrong', 'EDECRYPT');
  }
  // Some firmwares pad the JSON with NUL bytes.
  text = text.replace(/\0+$/, '');
  try {
    return { deviceId, stamp, payload: JSON.parse(text) };
  } catch (err) {
    throw new MiioError(`Unparseable reply: ${text.slice(0, 200)}`, 'EBADJSON');
  }
}

class MiioClient {
  /**
   * @param {object} options
   * @param {string} options.host    device IP address
   * @param {string} options.token   32 hex characters
   * @param {number} [options.port]
   * @param {number} [options.timeout]  per attempt, in milliseconds
   * @param {number} [options.retries]  extra attempts after a timeout
   */
  constructor({ host, token, port = PORT, timeout = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES }) {
    if (!host) throw new MiioError('A device address is required', 'ENOHOST');
    this.host = host;
    this.port = port;
    this.token = parseToken(token);
    this.timeout = timeout;
    this.retries = retries;

    this.deviceId = null;
    this.stampOffset = 0;
    this.lastHandshake = 0;
    this.nextId = 1 + crypto.randomInt(10000);

    this.socket = null;
    this.pending = new Map();
    this.handshakeWaiters = [];
    this.handshakeInFlight = null;
    // Commands are sent one at a time: the device handles them in order anyway,
    // and a queue keeps a burst from the Home app from flooding it.
    this.queue = Promise.resolve();
  }

  ensureSocket() {
    if (this.socket) return this.socket;
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    socket.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.closeSocket();
    });
    socket.unref();
    this.socket = socket;
    return socket;
  }

  closeSocket() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (err) {
      // already closed
    }
    this.socket = null;
  }

  onMessage(msg, rinfo) {
    if (rinfo.address !== this.host) return;
    let packet;
    try {
      packet = decodePacket(msg, null);
    } catch (err) {
      return;
    }

    if (msg.readUInt16BE(2) === HEADER_LENGTH) {
      const waiters = this.handshakeWaiters;
      this.handshakeWaiters = [];
      for (const resolve of waiters) resolve(packet);
      return;
    }

    try {
      packet = decodePacket(msg, this.token);
    } catch (err) {
      // A reply we cannot read (wrong token) fails every outstanding request.
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      return;
    }
    const id = packet.payload && packet.payload.id;
    const waiter = this.pending.get(id);
    if (waiter) {
      this.pending.delete(id);
      waiter.resolve(packet);
    }
  }

  send(buffer) {
    const socket = this.ensureSocket();
    return new Promise((resolve, reject) => {
      socket.send(buffer, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Send a hello packet and record the device id and clock from the reply.
   */
  async handshake() {
    if (this.handshakeInFlight) return this.handshakeInFlight;
    this.handshakeInFlight = (async () => {
      let lastError;
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        try {
          const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              this.handshakeWaiters = this.handshakeWaiters.filter((w) => w !== done);
              reject(new MiioTimeoutError(`No handshake reply from ${this.host}`));
            }, this.timeout);
            const done = (packet) => {
              clearTimeout(timer);
              resolve(packet);
            };
            this.handshakeWaiters.push(done);
            this.send(HELLO).catch((err) => {
              clearTimeout(timer);
              reject(err);
            });
          });
          this.deviceId = reply.deviceId;
          this.stampOffset = reply.stamp - Math.floor(Date.now() / 1000);
          this.lastHandshake = Date.now();
          return reply;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    })();
    try {
      return await this.handshakeInFlight;
    } finally {
      this.handshakeInFlight = null;
    }
  }

  takeRequestId(step = 1) {
    const id = this.nextId;
    this.nextId += step;
    if (this.nextId > MAX_REQUEST_ID) this.nextId = 1;
    return id;
  }

  /**
   * Call a method on the device and return its `result`.
   */
  call(method, params = [], options = {}) {
    const run = () => this.callNow(method, params, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async callNow(method, params, { retries = this.retries } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (!this.deviceId || Date.now() - this.lastHandshake > HANDSHAKE_TTL_MS) {
        await this.handshake();
      }

      const id = this.takeRequestId(attempt === 0 ? 1 : RETRY_ID_STEP);
      const payload = { id, method, params };
      const stamp = Math.floor(Date.now() / 1000) + this.stampOffset;
      const packet = encodePacket({
        token: this.token, deviceId: this.deviceId, stamp, payload,
      });

      try {
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new MiioTimeoutError(`${method} timed out after ${this.timeout} ms`));
          }, this.timeout);
          this.pending.set(id, {
            resolve: (value) => { clearTimeout(timer); resolve(value); },
            reject: (err) => { clearTimeout(timer); reject(err); },
          });
          this.send(packet).catch((err) => {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          });
        });

        this.lastHandshake = Date.now();
        const { error, result } = reply.payload;
        if (error) {
          throw new MiioError(`${method} failed: ${error.message || JSON.stringify(error)}`, error.code);
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!(err instanceof MiioTimeoutError)) throw err;
        // The device may have rebooted or changed its clock; redo the handshake.
        this.deviceId = null;
      }
    }
    throw lastError;
  }

  close() {
    for (const { reject } of this.pending.values()) reject(new MiioError('Client closed', 'ECLOSED'));
    this.pending.clear();
    this.closeSocket();
  }
}

/**
 * Broadcast a hello packet and collect every miIO device that answers.
 * Resolves to `[{ address, deviceId, stamp }]`.
 */
function discover({ timeout = 3000, broadcast = '255.255.255.255', port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.on('message', (msg, rinfo) => {
      try {
        const { deviceId, stamp } = decodePacket(msg, null);
        found.set(rinfo.address, { address: rinfo.address, deviceId, stamp });
      } catch (err) {
        // not a miIO reply
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      const sendHello = () => socket.send(HELLO, port, broadcast);
      sendHello();
      setTimeout(sendHello, timeout / 3);
      setTimeout(() => {
        socket.close();
        resolve([...found.values()]);
      }, timeout);
    });
  });
}

module.exports = {
  MiioClient,
  MiioError,
  MiioTimeoutError,
  discover,
  encodePacket,
  decodePacket,
  parseToken,
  PORT,
  HELLO,
};
