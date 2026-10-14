'use strict';

/**
 * A fake miIO device on 127.0.0.1, speaking the real wire protocol, so the
 * client is tested end to end without a robot.
 */

const dgram = require('dgram');
const { encodePacket, decodePacket } = require('../lib/miio');

const HEADER_LENGTH = 32;

class FakeDevice {
  constructor({ token, deviceId = 12345678, handler, dropFirst = 0 }) {
    this.token = Buffer.from(token, 'hex');
    this.deviceId = deviceId;
    this.handler = handler;
    this.dropFirst = dropFirst;
    this.stamp = 1000;
    this.calls = [];
    this.hellos = 0;
    this.socket = dgram.createSocket('udp4');
  }

  start() {
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    return new Promise((resolve) => {
      this.socket.bind(0, '127.0.0.1', () => resolve(this.socket.address().port));
    });
  }

  onMessage(msg, rinfo) {
    if (msg.readUInt16BE(2) === HEADER_LENGTH) {
      this.hellos += 1;
      const reply = Buffer.alloc(HEADER_LENGTH, 0);
      reply.writeUInt16BE(0x2131, 0);
      reply.writeUInt16BE(HEADER_LENGTH, 2);
      reply.writeUInt32BE(this.deviceId, 8);
      reply.writeUInt32BE(this.stamp, 12);
      reply.fill(0xff, 16);
      this.socket.send(reply, rinfo.port, rinfo.address);
      return;
    }

    let payload;
    try {
      ({ payload } = decodePacket(msg, this.token));
    } catch (err) {
      // Sealed with another token: answer with something only our token opens.
      this.send({ id: 0, error: { code: -1, message: 'decrypt failed' } }, rinfo);
      return;
    }
    this.calls.push(payload);
    if (this.dropFirst > 0) {
      this.dropFirst -= 1;
      return;
    }
    let response;
    try {
      response = { id: payload.id, result: this.handler(payload.method, payload.params) };
    } catch (err) {
      response = { id: payload.id, error: { code: -1, message: err.message } };
    }
    this.send(response, rinfo);
  }

  send(payload, rinfo) {
    this.stamp += 1;
    const packet = encodePacket({
      token: this.token, deviceId: this.deviceId, stamp: this.stamp, payload,
    });
    this.socket.send(packet, rinfo.port, rinfo.address);
  }

  stop() {
    this.socket.close();
  }
}

module.exports = { FakeDevice };
