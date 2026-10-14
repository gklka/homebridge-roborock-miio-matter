'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ms = require('../lib/matter-state');
const { STATE } = require('../lib/vacuum');

const OS = ms.OPERATIONAL_STATE;

test('tells the two suction schemes apart by the reported value', () => {
  assert.equal(ms.fanSchemeFor(102), 'codes');
  assert.equal(ms.fanSchemeFor(105), 'codes');
  assert.equal(ms.fanSchemeFor(60), 'percent');
  assert.equal(ms.fanSchemeFor(100), 'percent');
});

test('maps suction to clean modes and back', () => {
  assert.equal(ms.modeForFanPower('codes', 101), 0);
  assert.equal(ms.modeForFanPower('codes', 104), 3);
  assert.equal(ms.modeForFanPower('codes', 105), 4);
  assert.equal(ms.modeForFanPower('percent', 60), 1);
  // custom percentages snap to the nearest preset
  assert.equal(ms.modeForFanPower('percent', 90), 3);
  assert.equal(ms.modeForFanPower('percent', 40), 0);
  assert.equal(ms.modeForFanPower('codes', undefined), 1);

  assert.equal(ms.fanPowerForMode('codes', 2), 103);
  assert.equal(ms.fanPowerForMode('percent', 2), 75);
  assert.equal(ms.fanPowerForMode('percent', 4), undefined, 'old firmware has no mop setting');
  assert.equal(ms.fanPowerForMode('codes', 99), undefined);
});

test('old firmware does not offer the mop mode', () => {
  assert.deepEqual(ms.cleanModesFor('codes').map((mode) => mode.label), ['Quiet', 'Balanced', 'Turbo', 'Max', 'Mop']);
  assert.deepEqual(ms.cleanModesFor('percent').map((mode) => mode.label), ['Quiet', 'Balanced', 'Turbo', 'Max']);
});

test('every clean mode has a vacuum or mop tag and a unique tag set', () => {
  const modes = ms.cleanModesFor('codes');
  for (const mode of modes) {
    assert.ok(mode.tags.includes(ms.TAG.VACUUM) || mode.tags.includes(ms.TAG.MOP), mode.label);
  }
  const sets = modes.map((mode) => [...mode.tags].sort().join(','));
  assert.equal(new Set(sets).size, sets.length);
});

test('folds robot states into the four base operational states by default', () => {
  const at = (state, extra = {}) => ms.operationalStateFor({ state, battery: 50, ...extra });
  assert.equal(at(STATE.CLEANING), OS.RUNNING);
  assert.equal(at(STATE.SEGMENT_CLEANING), OS.RUNNING);
  assert.equal(at(STATE.ZONED_CLEANING), OS.RUNNING);
  assert.equal(at(STATE.PAUSED), OS.PAUSED);
  assert.equal(at(STATE.RETURNING_HOME), OS.RUNNING);
  assert.equal(at(STATE.CHARGING), OS.STOPPED);
  assert.equal(at(STATE.FULLY_CHARGED), OS.STOPPED);
  assert.equal(at(STATE.IDLE), OS.STOPPED);
  assert.equal(at(STATE.ERROR), OS.STOPPED);
});

test('reports dock, charging and errors when extended states are on', () => {
  const at = (state, extra = {}) => ms.operationalStateFor({ state, battery: 50, ...extra }, { extended: true });
  assert.equal(at(STATE.RETURNING_HOME), OS.SEEKING_CHARGER);
  assert.equal(at(STATE.DOCKING), OS.SEEKING_CHARGER);
  assert.equal(at(STATE.CHARGING), OS.CHARGING);
  assert.equal(at(STATE.CHARGING, { battery: 100 }), OS.DOCKED);
  assert.equal(at(STATE.FULLY_CHARGED), OS.DOCKED);
  assert.equal(at(STATE.ERROR), OS.ERROR);

  assert.equal(ms.operationalErrorFor({ state: STATE.ERROR, error_code: 8 }), ms.OPERATIONAL_ERROR.STUCK);
  assert.equal(ms.operationalErrorFor({ state: STATE.ERROR, error_code: 9 }), ms.OPERATIONAL_ERROR.DUST_BIN_MISSING);
  assert.equal(ms.operationalErrorFor({ state: STATE.ERROR, error_code: 5 }), ms.OPERATIONAL_ERROR.BRUSH_JAMMED);
  assert.equal(ms.operationalErrorFor({ state: STATE.ERROR, error_code: 200 }), ms.OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION);
  assert.equal(ms.operationalErrorFor({ state: STATE.CLEANING, error_code: 8 }), ms.OPERATIONAL_ERROR.NO_ERROR);
});

test('the run mode is Cleaning for the whole job, including pauses', () => {
  assert.equal(ms.runModeFor({ state: STATE.CLEANING }), ms.RUN_MODE.CLEANING);
  assert.equal(ms.runModeFor({ state: STATE.PAUSED }), ms.RUN_MODE.CLEANING);
  assert.equal(ms.runModeFor({ state: STATE.RETURNING_HOME }), ms.RUN_MODE.CLEANING);
  assert.equal(ms.runModeFor({ state: STATE.CHARGING, battery: 50 }), ms.RUN_MODE.IDLE);
  assert.equal(ms.runModeFor({ state: STATE.IDLE }), ms.RUN_MODE.IDLE);
});

test('builds a conformant cluster set', () => {
  const clusters = ms.buildClusters(
    {
      state: STATE.CHARGING, battery: 57, fan_power: 103, error_code: 0,
    },
    { fanScheme: 'codes', rooms: [{ segment: 16, name: 'Kitchen' }], selectedAreas: [16, 99] },
  );

  const runTags = clusters.rvcRunMode.supportedModes.map((mode) => mode.modeTags[0].value);
  assert.deepEqual(runTags, [ms.TAG.IDLE, ms.TAG.CLEANING]);
  assert.equal(clusters.rvcRunMode.currentMode, ms.RUN_MODE.IDLE);
  assert.equal(clusters.rvcCleanMode.currentMode, 2);

  const opState = clusters.rvcOperationalState;
  assert.equal(opState.phaseList, null);
  assert.equal(opState.currentPhase, null);
  assert.deepEqual(opState.operationalStateList, [0, 1, 2, 3].map((id) => ({ operationalStateId: id })));
  assert.ok(opState.operationalStateList.every((entry) => !('operationalStateLabel' in entry)));
  assert.equal(opState.operationalState, OS.STOPPED);

  assert.equal(clusters.powerSource.batPercentRemaining, 114);
  assert.equal(clusters.powerSource.batChargeState, 1);

  assert.deepEqual(clusters.serviceArea.supportedMaps, [{ mapId: 1, name: 'Home' }]);
  assert.deepEqual(clusters.serviceArea.supportedAreas, [{
    areaId: 16,
    mapId: 1,
    areaInfo: { locationInfo: { locationName: 'Kitchen', floorNumber: null, areaType: null }, landmarkInfo: null },
  }]);
  assert.deepEqual(clusters.serviceArea.selectedAreas, [16], 'unknown areas are dropped');
  assert.ok(!('progress' in clusters.serviceArea), 'no ProgressReporting feature');
});

test('leaves the room picker out when there are no rooms', () => {
  const clusters = ms.buildClusters({ state: STATE.IDLE, battery: 90, fan_power: 60 }, { fanScheme: 'percent' });
  assert.ok(!('serviceArea' in clusters));
});

test('battery levels map to charge level and state', () => {
  const power = (status) => ms.buildClusters(status, { fanScheme: 'codes' }).powerSource;
  assert.equal(power({ state: STATE.CLEANING, battery: 15 }).batChargeLevel, 1);
  assert.equal(power({ state: STATE.CLEANING, battery: 8 }).batChargeLevel, 2);
  assert.equal(power({ state: STATE.CLEANING, battery: 50 }).batChargeState, 3);
  assert.equal(power({ state: STATE.FULLY_CHARGED, battery: 100 }).batChargeState, 2);
  assert.equal(power({ state: STATE.IDLE }).batPercentRemaining, null);
});

test('diffs only the attributes that changed', () => {
  const before = { a: { x: 1, list: [1, 2] }, b: { y: 2 } };
  const after = { a: { x: 1, list: [1, 3] }, b: { y: 2 }, c: { z: 0 } };
  assert.deepEqual(ms.diffClusters(before, after), { a: { list: [1, 3] }, c: { z: 0 } });
  assert.deepEqual(ms.diffClusters(after, after), {});
});
