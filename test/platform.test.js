'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { RoborockMiioPlatform } = require('../lib/platform');
const { STATE } = require('../lib/vacuum');
const ms = require('../lib/matter-state');

function fakeLog() {
  const lines = [];
  const log = (level) => (...args) => lines.push([level, ...args]);
  return Object.assign(log('info'), {
    info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'), lines,
  });
}

function fakeApi({ matter = true } = {}) {
  const api = new EventEmitter();
  api.registered = [];
  api.updates = [];
  if (matter) {
    api.matter = {
      uuid: { generate: (seed) => `uuid:${seed}` },
      deviceTypes: { RoboticVacuumCleaner: { name: 'RoboticVacuumCleaner' } },
      registerPlatformAccessories: async (plugin, platform, accessories) => {
        api.registered.push(...accessories);
      },
      updateAccessoryState: async (uuid, cluster, attributes) => {
        api.updates.push({ uuid, cluster, attributes });
      },
    };
  }
  return api;
}

class FakeVacuum {
  constructor(status, { rooms = [] } = {}) {
    this.status = status;
    this.rooms = rooms;
    this.deviceId = 424242;
    this.host = '192.168.0.50';
    this.commands = [];
  }

  async getStatus() { return { ...this.status }; }

  async getInfo() { return { model: 'roborock.vacuum.s5', fw_ver: '3.5.8_002034' }; }

  async getSerialNumber() { return 'S5SERIAL'; }

  async getRooms() { return this.rooms.map((segment) => ({ segment, cloudId: String(segment * 100) })); }

  record(name, ...args) { this.commands.push([name, ...args]); }

  async start() { this.record('start'); }

  async pause() { this.record('pause'); }

  async stop() { this.record('stop'); }

  async returnToDock(options) { this.record('dock', options); }

  async cleanRooms(segments) { this.record('cleanRooms', segments); }

  async resumeRoomClean() { this.record('resumeRoomClean'); }

  async findMe() { this.record('findMe'); }

  async setFanPower(value) { this.record('fan', value); }

  close() {}
}

async function startPlatform({ status, rooms, config = {} } = {}) {
  const api = fakeApi();
  const vacuum = new FakeVacuum(status || {
    state: STATE.CHARGING, battery: 80, fan_power: 102, error_code: 0,
  }, { rooms });
  const platform = new RoborockMiioPlatform(fakeLog(), {
    host: '192.168.0.50', token: '00112233445566778899aabbccddeeff', ...config,
  }, api, { vacuum });
  await platform.start();
  return { api, vacuum, platform };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((resolve) => setImmediate(resolve)));
}

test('registers one robot vacuum with identity from the robot', async (t) => {
  const { api, platform } = await startPlatform({ config: { name: 'Mr Robot' } });
  t.after(() => platform.shutdown());

  assert.equal(api.registered.length, 1);
  const accessory = api.registered[0];
  assert.equal(accessory.UUID, 'uuid:homebridge-roborock-miio-matter:424242');
  assert.equal(accessory.displayName, 'Mr Robot');
  assert.equal(accessory.model, 'roborock.vacuum.s5');
  assert.equal(accessory.serialNumber, 'S5SERIAL');
  assert.equal(accessory.firmwareRevision, '3.5.8_002034');
  assert.equal(accessory.deviceType, api.matter.deviceTypes.RoboticVacuumCleaner);
  assert.deepEqual(Object.keys(accessory.clusters).sort(),
    ['powerSource', 'rvcCleanMode', 'rvcOperationalState', 'rvcRunMode']);
  assert.ok(!accessory.handlers.serviceArea);
});

test('does nothing without Matter, and says why', async () => {
  const api = fakeApi({ matter: false });
  const log = fakeLog();
  const platform = new RoborockMiioPlatform(log, { host: 'h', token: '00112233445566778899aabbccddeeff' }, api, { vacuum: new FakeVacuum({}) });
  await platform.start();
  assert.ok(log.lines.some(([level, message]) => level === 'error' && /Matter is not enabled/.test(message)));
});

test('rejects a config without host or token', () => {
  const log = fakeLog();
  const platform = new RoborockMiioPlatform(log, {}, fakeApi());
  assert.equal(platform.vacuum, undefined);
  assert.ok(log.lines.some(([level]) => level === 'error'));
});

test('start, pause, resume and dock map to robot commands', async (t) => {
  const { api, vacuum, platform } = await startPlatform();
  t.after(() => platform.shutdown());
  const { handlers } = api.registered[0];

  await handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING });
  assert.deepEqual(vacuum.commands.pop(), ['start']);
  await settle();
  const opUpdate = api.updates.filter((update) => update.cluster === 'rvcOperationalState').pop();
  assert.equal(opUpdate.attributes.operationalState, ms.OPERATIONAL_STATE.RUNNING, 'shown as running straight away');

  vacuum.status.state = STATE.CLEANING;
  await platform.poll();
  await handlers.rvcOperationalState.pause();
  assert.deepEqual(vacuum.commands.pop(), ['pause']);

  vacuum.status.state = STATE.PAUSED;
  await platform.poll();
  await handlers.rvcOperationalState.resume();
  assert.deepEqual(vacuum.commands.pop(), ['start']);

  vacuum.status.state = STATE.CLEANING;
  await platform.poll();
  await handlers.rvcOperationalState.goHome();
  assert.deepEqual(vacuum.commands.pop(), ['dock', { pauseFirst: true }]);
});

test('a start while already cleaning sends nothing', async (t) => {
  const { api, vacuum, platform } = await startPlatform({ status: { state: STATE.CLEANING, battery: 60, fan_power: 102 } });
  t.after(() => platform.shutdown());
  await api.registered[0].handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING });
  assert.deepEqual(vacuum.commands, []);
});

test('Idle stops a running robot', async (t) => {
  const { api, vacuum, platform } = await startPlatform({ status: { state: STATE.CLEANING, battery: 60, fan_power: 102 } });
  t.after(() => platform.shutdown());
  await api.registered[0].handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.IDLE });
  assert.deepEqual(vacuum.commands, [['stop']]);
});

test('selected rooms are cleaned, and a paused room clean resumes as one', async (t) => {
  const { api, vacuum, platform } = await startPlatform({
    rooms: [16, 17, 18],
    config: { rooms: [{ segment: 16, name: 'Kitchen' }, { segment: 17, name: 'Hall' }, { segment: 99, name: 'Gone' }] },
  });
  t.after(() => platform.shutdown());
  const accessory = api.registered[0];

  assert.deepEqual(accessory.clusters.serviceArea.supportedAreas.map((area) => area.areaInfo.locationInfo.locationName),
    ['Kitchen', 'Hall', 'Room 18']);

  await accessory.handlers.serviceArea.selectAreas({ newAreas: [17, 16] });
  await accessory.handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING });
  assert.deepEqual(vacuum.commands.pop(), ['cleanRooms', [17, 16]]);

  vacuum.status.state = STATE.SEGMENT_CLEANING;
  await platform.poll();
  vacuum.status.state = STATE.PAUSED;
  await platform.poll();
  await accessory.handlers.rvcOperationalState.resume();
  assert.deepEqual(vacuum.commands.pop(), ['resumeRoomClean']);
});

test('unnamed rooms can be hidden', async (t) => {
  const { api, platform } = await startPlatform({
    rooms: [16, 17],
    config: { unnamedRooms: false, rooms: [{ segment: 17, name: 'Hall' }] },
  });
  t.after(() => platform.shutdown());
  assert.deepEqual(api.registered[0].clusters.serviceArea.supportedAreas.map((area) => area.areaId), [17]);
});

test('configured rooms are trusted when the robot lists none', async (t) => {
  const { api, vacuum, platform } = await startPlatform({
    rooms: [],
    config: { rooms: [{ segment: 16, name: 'Kitchen' }, { segment: 18, name: 'Bedroom' }] },
  });
  t.after(() => platform.shutdown());
  const accessory = api.registered[0];
  assert.deepEqual(accessory.clusters.serviceArea.supportedAreas.map((area) => area.areaId), [16, 18]);
  await accessory.handlers.serviceArea.selectAreas({ newAreas: [18] });
  await accessory.handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING });
  assert.deepEqual(vacuum.commands.pop(), ['cleanRooms', [18]]);
});

test('no rooms anywhere means no room picker', async (t) => {
  const { api, platform } = await startPlatform({ rooms: [] });
  t.after(() => platform.shutdown());
  assert.ok(!api.registered[0].clusters.serviceArea);
});

test('an unknown room selection is not stored', async (t) => {
  const { api, vacuum, platform } = await startPlatform({ rooms: [16] });
  t.after(() => platform.shutdown());
  const { handlers } = api.registered[0];
  await handlers.serviceArea.selectAreas({ newAreas: [16, 40] });
  await handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING });
  assert.deepEqual(vacuum.commands.pop(), ['start']);
});

test('clean modes set the suction in the robot\'s own scheme', async (t) => {
  const { api, vacuum, platform } = await startPlatform({ status: { state: STATE.CHARGING, battery: 90, fan_power: 60 } });
  t.after(() => platform.shutdown());
  const { handlers, clusters } = api.registered[0];
  assert.equal(clusters.rvcCleanMode.supportedModes.length, 4);
  await handlers.rvcCleanMode.changeToMode({ newMode: 3 });
  assert.deepEqual(vacuum.commands.pop(), ['fan', 100]);
});

test('a failing robot command is reported to the Home app', async (t) => {
  const { api, vacuum, platform } = await startPlatform();
  t.after(() => platform.shutdown());
  vacuum.start = async () => { throw new Error('timed out'); };
  await assert.rejects(api.registered[0].handlers.rvcRunMode.changeToMode({ newMode: ms.RUN_MODE.CLEANING }), /timed out/);
});

test('polling publishes only what changed', async (t) => {
  const { api, vacuum, platform } = await startPlatform();
  t.after(() => platform.shutdown());

  await platform.poll();
  assert.equal(api.updates.length, 0, 'nothing changed since registration');

  vacuum.status.battery = 81;
  await platform.poll();
  assert.deepEqual(api.updates.map((update) => update.cluster), ['powerSource']);
  assert.deepEqual(api.updates[0].attributes, { batPercentRemaining: 162 });
});

test('a run mode the Matter store restored from disk is corrected', async (t) => {
  const { api, platform } = await startPlatform();
  t.after(() => platform.shutdown());

  // matter.js restores the persisted run mode over the one given at
  // registration, so the store can say Cleaning while the robot is docked.
  const store = JSON.parse(JSON.stringify(api.registered[0].clusters));
  store.rvcRunMode.currentMode = ms.RUN_MODE.CLEANING;
  api.matter.getAccessoryState = async (uuid, cluster) => store[cluster];

  await platform.poll();
  assert.deepEqual(api.updates.map((update) => [update.cluster, update.attributes]),
    [['rvcRunMode', { currentMode: ms.RUN_MODE.IDLE }]]);
});

test('the optimistic state gives way to the robot once it moves on', async (t) => {
  const { api, vacuum, platform } = await startPlatform();
  t.after(() => platform.shutdown());

  await api.registered[0].handlers.rvcOperationalState.goHome();
  assert.equal(platform.currentState(), STATE.RETURNING_HOME);
  await platform.poll();
  assert.equal(platform.currentState(), STATE.RETURNING_HOME, 'robot has not reacted yet');
  vacuum.status.state = STATE.IDLE;
  await platform.poll();
  assert.equal(platform.currentState(), STATE.IDLE);
});
