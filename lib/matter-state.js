'use strict';

/**
 * Pure translation between Roborock status and the Matter robotic vacuum
 * clusters. No I/O here, so all of it is covered by unit tests.
 */

const { STATE } = require('./vacuum');

/** RvcRunMode / RvcCleanMode mode tags (Matter 1.4). */
const TAG = {
  AUTO: 0,
  QUIET: 2,
  MAX: 7,
  IDLE: 0x4000,
  CLEANING: 0x4001,
  DEEP_CLEAN: 0x4000,
  VACUUM: 0x4001,
  MOP: 0x4002,
};

const RUN_MODE = { IDLE: 0, CLEANING: 1 };

const OPERATIONAL_STATE = {
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  SEEKING_CHARGER: 64,
  CHARGING: 65,
  DOCKED: 66,
};

const OPERATIONAL_ERROR = {
  NO_ERROR: 0,
  UNABLE_TO_COMPLETE_OPERATION: 2,
  FAILED_TO_FIND_CHARGING_DOCK: 64,
  STUCK: 65,
  DUST_BIN_MISSING: 66,
  DUST_BIN_FULL: 67,
  LOW_BATTERY: 72,
  WHEELS_JAMMED: 76,
  BRUSH_JAMMED: 77,
  NAVIGATION_SENSOR_OBSCURED: 78,
};

/**
 * The fan_power values the firmware understands. Firmware before 3.5.7 takes a
 * percentage; later versions use fixed codes 101-105, with 105 a gentle setting
 * meant for mopping. Which one a robot speaks is told apart by the value it
 * currently reports.
 */
const FAN_SCHEMES = {
  codes: { quiet: 101, balanced: 102, turbo: 103, max: 104, mop: 105 },
  percent: { quiet: 38, balanced: 60, turbo: 75, max: 100 },
};

/** The Matter clean modes, in the order Apple Home lists them. */
const CLEAN_MODES = [
  { mode: 0, key: 'quiet', label: 'Quiet', tags: [TAG.QUIET, TAG.VACUUM] },
  { mode: 1, key: 'balanced', label: 'Balanced', tags: [TAG.AUTO, TAG.VACUUM] },
  { mode: 2, key: 'turbo', label: 'Turbo', tags: [TAG.DEEP_CLEAN, TAG.VACUUM] },
  { mode: 3, key: 'max', label: 'Max', tags: [TAG.MAX, TAG.VACUUM] },
  { mode: 4, key: 'mop', label: 'Mop', tags: [TAG.MOP] },
];

const DEFAULT_CLEAN_MODE = 1;

function fanSchemeFor(fanPower) {
  return Number(fanPower) > 100 ? 'codes' : 'percent';
}

function cleanModesFor(scheme) {
  const fan = FAN_SCHEMES[scheme];
  return CLEAN_MODES.filter((entry) => fan[entry.key] !== undefined);
}

function fanPowerForMode(scheme, mode) {
  const entry = CLEAN_MODES.find((candidate) => candidate.mode === mode);
  if (!entry) return undefined;
  return FAN_SCHEMES[scheme][entry.key];
}

/** The clean mode closest to a reported fan_power. */
function modeForFanPower(scheme, fanPower) {
  const value = Number(fanPower);
  if (!Number.isFinite(value)) return DEFAULT_CLEAN_MODE;
  let best = DEFAULT_CLEAN_MODE;
  let bestDistance = Infinity;
  for (const entry of cleanModesFor(scheme)) {
    const distance = Math.abs(FAN_SCHEMES[scheme][entry.key] - value);
    if (distance < bestDistance) {
      best = entry.mode;
      bestDistance = distance;
    }
  }
  return best;
}

function isActive(state) {
  switch (state) {
    case STATE.STARTING:
    case STATE.REMOTE_CONTROL:
    case STATE.CLEANING:
    case STATE.MANUAL_MODE:
    case STATE.SPOT_CLEANING:
    case STATE.GOING_TO_TARGET:
    case STATE.ZONED_CLEANING:
    case STATE.SEGMENT_CLEANING:
      return true;
    default:
      return false;
  }
}

function isReturning(state) {
  return state === STATE.RETURNING_HOME || state === STATE.DOCKING;
}

function isOnDock(status) {
  return status.state === STATE.CHARGING || status.state === STATE.FULLY_CHARGED
    || status.state === STATE.CHARGING_PROBLEM;
}

/**
 * The operational state in full detail. With `extended` off it is folded into
 * the four base states: Apple Home has been seen refusing to pair a vacuum
 * whose state list holds more than the base four, so the safe default is to
 * advertise only those.
 */
function operationalStateFor(status, { extended = false } = {}) {
  let detailed;
  if (status.state === STATE.ERROR || status.state === STATE.CHARGING_PROBLEM) {
    detailed = OPERATIONAL_STATE.ERROR;
  } else if (status.state === STATE.PAUSED) {
    detailed = OPERATIONAL_STATE.PAUSED;
  } else if (isActive(status.state)) {
    detailed = OPERATIONAL_STATE.RUNNING;
  } else if (isReturning(status.state)) {
    detailed = OPERATIONAL_STATE.SEEKING_CHARGER;
  } else if (status.state === STATE.CHARGING) {
    detailed = status.battery >= 100 ? OPERATIONAL_STATE.DOCKED : OPERATIONAL_STATE.CHARGING;
  } else if (status.state === STATE.FULLY_CHARGED) {
    detailed = OPERATIONAL_STATE.DOCKED;
  } else {
    detailed = OPERATIONAL_STATE.STOPPED;
  }

  if (extended) return detailed;
  switch (detailed) {
    case OPERATIONAL_STATE.SEEKING_CHARGER:
      // Still on the move, so the Home app keeps offering Pause.
      return OPERATIONAL_STATE.RUNNING;
    case OPERATIONAL_STATE.CHARGING:
    case OPERATIONAL_STATE.DOCKED:
    case OPERATIONAL_STATE.ERROR:
      return OPERATIONAL_STATE.STOPPED;
    default:
      return detailed;
  }
}

function operationalStateListFor({ extended = false } = {}) {
  const base = [
    OPERATIONAL_STATE.STOPPED,
    OPERATIONAL_STATE.RUNNING,
    OPERATIONAL_STATE.PAUSED,
    OPERATIONAL_STATE.ERROR,
  ];
  if (!extended) return base;
  return [...base, OPERATIONAL_STATE.SEEKING_CHARGER, OPERATIONAL_STATE.CHARGING, OPERATIONAL_STATE.DOCKED];
}

function operationalErrorFor(status) {
  if (status.state !== STATE.ERROR && status.state !== STATE.CHARGING_PROBLEM) {
    return OPERATIONAL_ERROR.NO_ERROR;
  }
  switch (status.error_code) {
    case 3:
    case 8:
    case 16:
      return OPERATIONAL_ERROR.STUCK;
    case 7:
      return OPERATIONAL_ERROR.WHEELS_JAMMED;
    case 5:
    case 6:
      return OPERATIONAL_ERROR.BRUSH_JAMMED;
    case 1:
    case 15:
    case 21:
      return OPERATIONAL_ERROR.NAVIGATION_SENSOR_OBSCURED;
    case 9:
      return OPERATIONAL_ERROR.DUST_BIN_MISSING;
    case 254:
      return OPERATIONAL_ERROR.DUST_BIN_FULL;
    case 12:
      return OPERATIONAL_ERROR.LOW_BATTERY;
    case 13:
    case 19:
    case 22:
    case 23:
      return OPERATIONAL_ERROR.FAILED_TO_FIND_CHARGING_DOCK;
    default:
      return OPERATIONAL_ERROR.UNABLE_TO_COMPLETE_OPERATION;
  }
}

function runModeFor(status) {
  const state = operationalStateFor(status, { extended: true });
  return state === OPERATIONAL_STATE.RUNNING || state === OPERATIONAL_STATE.PAUSED
    || state === OPERATIONAL_STATE.SEEKING_CHARGER
    ? RUN_MODE.CLEANING
    : RUN_MODE.IDLE;
}

/** PowerSource: Matter counts battery in half-percent steps (200 = 100%). */
function powerSourceFor(status) {
  const battery = Number.isFinite(status.battery) ? Math.max(0, Math.min(100, status.battery)) : null;
  let chargeState = 0; // unknown
  if (battery !== null) {
    if (isOnDock(status)) {
      chargeState = battery >= 100 ? 2 : 1; // full : charging
    } else {
      chargeState = 3; // not charging
    }
  }
  let chargeLevel = 0; // ok
  if (battery !== null && battery <= 10) chargeLevel = 2;
  else if (battery !== null && battery < 20) chargeLevel = 1;
  return {
    status: battery === null ? 3 : 1, // unavailable : active
    order: 0,
    description: 'Battery',
    batPresent: battery !== null,
    batPercentRemaining: battery === null ? null : battery * 2,
    batChargeLevel: chargeLevel,
    batChargeState: chargeState,
    batReplacementNeeded: false,
    batReplaceability: 0,
    batFunctionalWhileCharging: true,
    batChargingCurrent: null,
  };
}

/**
 * The robot keeps one map, so the rooms hang off a single Matter map. Leaving
 * the map list out is what the spec suggests for that case, but matter.js
 * (0.17) then fails to initialise the cluster, so the map is spelled out.
 */
const MAP = { mapId: 1, name: 'Home' };

function serviceAreaFor(rooms, selectedAreas = []) {
  return {
    supportedMaps: [MAP],
    supportedAreas: rooms.map((room) => ({
      areaId: room.segment,
      mapId: MAP.mapId,
      areaInfo: {
        locationInfo: { locationName: room.name, floorNumber: null, areaType: null },
        landmarkInfo: null,
      },
    })),
    selectedAreas: selectedAreas.filter((id) => rooms.some((room) => room.segment === id)),
    currentArea: null,
    estimatedEndTime: null,
  };
}

/**
 * Every cluster the accessory publishes, for one status snapshot.
 *
 * @param {object} status        get_status result
 * @param {object} options
 * @param {string} options.fanScheme   'codes' | 'percent'
 * @param {Array}  options.rooms       [{ segment, name }]; [] hides the room picker
 * @param {number[]} [options.selectedAreas]
 * @param {boolean} [options.extended]  advertise the RVC-specific states too
 */
function buildClusters(status, {
  fanScheme, rooms = [], selectedAreas = [], extended = false,
}) {
  const clusters = {
    rvcRunMode: {
      supportedModes: [
        { label: 'Idle', mode: RUN_MODE.IDLE, modeTags: [{ value: TAG.IDLE }] },
        { label: 'Cleaning', mode: RUN_MODE.CLEANING, modeTags: [{ value: TAG.CLEANING }] },
      ],
      currentMode: runModeFor(status),
    },
    rvcCleanMode: {
      supportedModes: cleanModesFor(fanScheme).map((entry) => ({
        label: entry.label,
        mode: entry.mode,
        modeTags: entry.tags.map((value) => ({ value })),
      })),
      currentMode: modeForFanPower(fanScheme, status.fan_power),
    },
    rvcOperationalState: {
      // Required to be null for a robotic vacuum.
      phaseList: null,
      currentPhase: null,
      // Bare ids: labels on the standard states have stopped Apple Home pairing.
      operationalStateList: operationalStateListFor({ extended }).map((id) => ({ operationalStateId: id })),
      operationalState: operationalStateFor(status, { extended }),
      operationalError: { errorStateId: extended ? operationalErrorFor(status) : OPERATIONAL_ERROR.NO_ERROR },
    },
    powerSource: powerSourceFor(status),
  };
  if (rooms.length > 0) {
    clusters.serviceArea = serviceAreaFor(rooms, selectedAreas);
  }
  return clusters;
}

/**
 * The attributes in `next` that differ from `previous`, per cluster, so an
 * update only sends what changed. Lists and structs compare by value.
 */
function diffClusters(previous, next) {
  const changes = {};
  for (const [cluster, attributes] of Object.entries(next)) {
    const before = (previous && previous[cluster]) || {};
    for (const [name, value] of Object.entries(attributes)) {
      if (JSON.stringify(before[name]) !== JSON.stringify(value)) {
        if (!changes[cluster]) changes[cluster] = {};
        changes[cluster][name] = value;
      }
    }
  }
  return changes;
}

module.exports = {
  TAG,
  RUN_MODE,
  OPERATIONAL_STATE,
  OPERATIONAL_ERROR,
  FAN_SCHEMES,
  CLEAN_MODES,
  fanSchemeFor,
  cleanModesFor,
  fanPowerForMode,
  modeForFanPower,
  operationalStateFor,
  operationalErrorFor,
  runModeFor,
  isActive,
  buildClusters,
  diffClusters,
};
