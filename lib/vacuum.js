'use strict';

/**
 * Roborock commands over miIO, as used by the robots that pair with the Xiaomi
 * Home app (S5, S50/S55, S6, Mi Robot Vacuum and similar).
 */

const { MiioClient } = require('./miio');

/** `state` values reported by get_status. */
const STATE = {
  STARTING: 1,
  CHARGER_DISCONNECTED: 2,
  IDLE: 3,
  REMOTE_CONTROL: 4,
  CLEANING: 5,
  RETURNING_HOME: 6,
  MANUAL_MODE: 7,
  CHARGING: 8,
  CHARGING_PROBLEM: 9,
  PAUSED: 10,
  SPOT_CLEANING: 11,
  ERROR: 12,
  SHUTTING_DOWN: 13,
  UPDATING: 14,
  DOCKING: 15,
  GOING_TO_TARGET: 16,
  ZONED_CLEANING: 17,
  SEGMENT_CLEANING: 18,
  FULLY_CHARGED: 100,
};

const STATE_NAMES = {
  1: 'starting',
  2: 'charger disconnected',
  3: 'idle',
  4: 'remote control',
  5: 'cleaning',
  6: 'returning home',
  7: 'manual mode',
  8: 'charging',
  9: 'charging problem',
  10: 'paused',
  11: 'spot cleaning',
  12: 'error',
  13: 'shutting down',
  14: 'updating',
  15: 'docking',
  16: 'going to target',
  17: 'zoned cleaning',
  18: 'room cleaning',
  100: 'fully charged',
};

/** `error_code` values reported by get_status. */
const ERROR_NAMES = {
  0: 'no error',
  1: 'laser distance sensor error',
  2: 'collision sensor error',
  3: 'wheels on top of void',
  4: 'cliff sensor error',
  5: 'main brush jammed',
  6: 'side brush jammed',
  7: 'wheels jammed',
  8: 'robot stuck',
  9: 'dust bin missing',
  10: 'filter blocked',
  11: 'magnetic field detected',
  12: 'low battery',
  13: 'charging problem',
  14: 'battery failure',
  15: 'wall sensor dirty',
  16: 'uneven surface',
  17: 'side brush error',
  18: 'suction fan error',
  19: 'dock has no power',
  20: 'unknown error',
  21: 'laser pressure sensor problem',
  22: 'charge sensor problem',
  23: 'dock problem',
  24: 'no-go zone or invisible wall detected',
  254: 'bin full',
  255: 'internal error',
};

function stateName(code) {
  return STATE_NAMES[code] || `state ${code}`;
}

function errorName(code) {
  return ERROR_NAMES[code] || `error ${code}`;
}

class RoborockVacuum {
  /**
   * @param {object} options  passed through to MiioClient (host, token, timeout, retries)
   */
  constructor(options) {
    this.client = options.client || new MiioClient(options);
  }

  get deviceId() {
    return this.client.deviceId;
  }

  get host() {
    return this.client.host;
  }

  call(method, params) {
    return this.client.call(method, params);
  }

  /** Returns the status object (state, battery, fan_power, error_code, ...). */
  async getStatus() {
    const result = await this.call('get_status');
    return Array.isArray(result) ? result[0] : result;
  }

  /** Model, firmware version and network details. */
  getInfo() {
    return this.call('miIO.info');
  }

  async getSerialNumber() {
    try {
      const result = await this.call('get_serial_number');
      const entry = Array.isArray(result) ? result[0] : result;
      return entry && entry.serial_number ? String(entry.serial_number) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * The rooms on the saved map, as `[{ segment, cloudId }]`. Room names live in
   * the Xiaomi cloud, not on the robot, so they are not available here.
   * Resolves to [] when the firmware has no room support or no map is saved.
   */
  async getRooms() {
    let result;
    try {
      result = await this.call('get_room_mapping');
    } catch (err) {
      return [];
    }
    if (!Array.isArray(result)) return [];
    return result
      .filter((entry) => Array.isArray(entry) && Number.isInteger(entry[0]))
      .map(([segment, cloudId]) => ({ segment, cloudId: cloudId == null ? null : String(cloudId) }));
  }

  start() {
    return this.call('app_start');
  }

  pause() {
    return this.call('app_pause');
  }

  stop() {
    return this.call('app_stop');
  }

  /** Stop where it is and drive back to the dock. */
  async returnToDock({ pauseFirst = false } = {}) {
    if (pauseFirst) {
      // A robot in the middle of a room clean ignores app_charge until paused.
      try {
        await this.pause();
      } catch (err) {
        // carry on: the dock command is what matters
      }
    }
    return this.call('app_charge');
  }

  cleanRooms(segments) {
    return this.call('app_segment_clean', segments.map(Number));
  }

  resumeRoomClean() {
    return this.call('resume_segment_clean');
  }

  findMe() {
    return this.call('find_me', ['']);
  }

  setFanPower(value) {
    return this.call('set_custom_mode', [Number(value)]);
  }

  close() {
    this.client.close();
  }
}

module.exports = {
  RoborockVacuum,
  STATE,
  STATE_NAMES,
  ERROR_NAMES,
  stateName,
  errorName,
};
