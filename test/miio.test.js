'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MiioClient, MiioError, MiioTimeoutError, encodePacket, decodePacket, parseToken,
} = require('../lib/miio');
const { RoborockVacuum } = require('../lib/vacuum');
const { FakeDevice } = require('./fake-device');

const TOKEN = '00112233445566778899aabbccddeeff';
const OTHER_TOKEN = 'ffeeddccbbaa99887766554433221100';

test('a packet survives an encode/decode round trip', () => {
  const token = parseToken(TOKEN);
  const payload = { id: 7, method: 'get_status', params: [] };
  const packet = encodePacket({
    token, deviceId: 42, stamp: 99, payload,
  });
  assert.equal(packet.readUInt16BE(0), 0x2131);
  assert.equal(packet.readUInt16BE(2), packet.length);
  assert.deepEqual(decodePacket(packet, token), { deviceId: 42, stamp: 99, payload });
});

test('a reply sealed with another token is reported as a token problem', () => {
  const packet = encodePacket({
    token: parseToken(OTHER_TOKEN), deviceId: 1, stamp: 1, payload: { id: 1 },
  });
  assert.throws(() => decodePacket(packet, parseToken(TOKEN)), (err) => err.code === 'ECHECKSUM');
});

test('tokens are validated up front', () => {
  assert.throws(() => parseToken('abc'), MiioError);
  assert.throws(() => new MiioClient({ host: '127.0.0.1', token: 'zz'.repeat(16) }), MiioError);
  assert.equal(parseToken(` ${TOKEN.toUpperCase()} `).toString('hex'), TOKEN);
});

test('handshakes, then calls a method on the device', async (t) => {
  const device = new FakeDevice({
    token: TOKEN,
    handler: (method) => (method === 'get_status' ? [{ state: 8, battery: 100 }] : 'ok'),
  });
  const port = await device.start();
  const client = new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 500 });
  t.after(() => { client.close(); device.stop(); });

  assert.deepEqual(await client.call('get_status'), [{ state: 8, battery: 100 }]);
  assert.equal(client.deviceId, 12345678);
  assert.equal(device.hellos, 1);
  assert.equal(await client.call('app_start'), 'ok');
  assert.equal(device.hellos, 1, 'the handshake is reused');
});

test('retries a lost request with a fresh id', async (t) => {
  const device = new FakeDevice({ token: TOKEN, dropFirst: 1, handler: () => ['ok'] });
  const port = await device.start();
  const client = new MiioClient({
    host: '127.0.0.1', port, token: TOKEN, timeout: 200, retries: 2,
  });
  t.after(() => { client.close(); device.stop(); });

  assert.deepEqual(await client.call('app_pause'), ['ok']);
  assert.equal(device.calls.length, 2);
  assert.notEqual(device.calls[0].id, device.calls[1].id);
  assert.equal(device.hellos, 2, 'a timeout forces a new handshake');
});

test('gives up after the retries with a timeout error', async (t) => {
  const device = new FakeDevice({ token: TOKEN, dropFirst: 10, handler: () => ['ok'] });
  const port = await device.start();
  const client = new MiioClient({
    host: '127.0.0.1', port, token: TOKEN, timeout: 100, retries: 1,
  });
  t.after(() => { client.close(); device.stop(); });

  await assert.rejects(client.call('get_status'), MiioTimeoutError);
});

test('surfaces device errors', async (t) => {
  const device = new FakeDevice({
    token: TOKEN,
    handler: () => { throw new Error('unknown_method'); },
  });
  const port = await device.start();
  const client = new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 300 });
  t.after(() => { client.close(); device.stop(); });

  await assert.rejects(client.call('nope'), /unknown_method/);
});

test('a wrong token fails fast instead of timing out', async (t) => {
  const device = new FakeDevice({ token: OTHER_TOKEN, handler: () => ['ok'] });
  const port = await device.start();
  const client = new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 2000 });
  t.after(() => { client.close(); device.stop(); });

  const started = Date.now();
  await assert.rejects(client.call('get_status'), (err) => err.code === 'ECHECKSUM');
  assert.ok(Date.now() - started < 1000);
});

test('concurrent calls are queued and each gets its own answer', async (t) => {
  const device = new FakeDevice({ token: TOKEN, handler: (method) => [method] });
  const port = await device.start();
  const client = new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 500 });
  t.after(() => { client.close(); device.stop(); });

  const results = await Promise.all(['a', 'b', 'c'].map((method) => client.call(method)));
  assert.deepEqual(results, [['a'], ['b'], ['c']]);
});

test('the vacuum wrapper unpacks status and rooms', async (t) => {
  const device = new FakeDevice({
    token: TOKEN,
    handler: (method, params) => {
      switch (method) {
        case 'get_status': return [{ state: 3, battery: 80, fan_power: 102 }];
        case 'get_room_mapping': return [[16, '1234'], [17, '5678']];
        case 'get_serial_number': return [{ serial_number: 'R1234S5' }];
        case 'app_segment_clean': return params;
        default: return ['ok'];
      }
    },
  });
  const port = await device.start();
  const vacuum = new RoborockVacuum({ client: new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 500 }) });
  t.after(() => { vacuum.close(); device.stop(); });

  assert.deepEqual(await vacuum.getStatus(), { state: 3, battery: 80, fan_power: 102 });
  assert.deepEqual(await vacuum.getRooms(), [{ segment: 16, cloudId: '1234' }, { segment: 17, cloudId: '5678' }]);
  assert.equal(await vacuum.getSerialNumber(), 'R1234S5');
  assert.deepEqual(await vacuum.cleanRooms(['16', 17]), [16, 17]);

  await vacuum.returnToDock({ pauseFirst: true });
  assert.deepEqual(device.calls.slice(-2).map((call) => call.method), ['app_pause', 'app_charge']);
});

test('a robot without room support reports no rooms', async (t) => {
  const device = new FakeDevice({
    token: TOKEN,
    handler: (method) => { if (method === 'get_room_mapping') throw new Error('unknown_method'); return ['ok']; },
  });
  const port = await device.start();
  const vacuum = new RoborockVacuum({ client: new MiioClient({ host: '127.0.0.1', port, token: TOKEN, timeout: 500 }) });
  t.after(() => { vacuum.close(); device.stop(); });

  assert.deepEqual(await vacuum.getRooms(), []);
});

test('finds the device again after it moves to another address', async (t) => {
  const device = new FakeDevice({ token: TOKEN, handler: () => ['ok'] });
  const port = await device.start();
  // Another miIO device on the network, with a token of its own.
  const stranger = new FakeDevice({
    token: OTHER_TOKEN, deviceId: 999, address: '127.0.0.3', handler: () => ['ok'],
  });
  await stranger.start(port);
  const moves = [];
  const client = new MiioClient({
    host: '127.0.0.2',
    port,
    token: TOKEN,
    timeout: 100,
    retries: 0,
    discover: async () => [
      { address: '127.0.0.3', deviceId: 999 },
      { address: '127.0.0.1', deviceId: 12345678 },
    ],
    onRelocate: (host, previous) => moves.push([host, previous]),
  });
  t.after(() => { client.close(); device.stop(); stranger.stop(); });

  assert.deepEqual(await client.call('get_status'), ['ok']);
  assert.equal(client.host, '127.0.0.1');
  assert.deepEqual(moves, [['127.0.0.1', '127.0.0.2']]);
});

test('a known device id rules out other devices, and searches are rate limited', async (t) => {
  const device = new FakeDevice({ token: TOKEN, handler: () => ['ok'] });
  const port = await device.start();
  let searches = 0;
  const client = new MiioClient({
    host: '127.0.0.1',
    port,
    token: TOKEN,
    timeout: 100,
    retries: 0,
    discover: async () => {
      searches += 1;
      // The same token answers here, but the device id says it is not ours.
      return [{ address: '127.0.0.1', deviceId: 1 }];
    },
  });
  t.after(() => { client.close(); device.stop(); });

  await client.call('get_status');
  client.host = '127.0.0.2';
  client.deviceId = null;
  await assert.rejects(client.call('get_status'), MiioTimeoutError);
  assert.equal(client.host, '127.0.0.2', 'only the known device id is tried, and it is not elsewhere');
  await assert.rejects(client.call('get_status'), MiioTimeoutError);
  assert.equal(searches, 1);
});
