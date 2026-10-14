'use strict';

const { PLATFORM_NAME, PLUGIN_NAME, ACCESSORY_SEED } = require('./settings');
const { RoborockVacuum, STATE, stateName, errorName } = require('./vacuum');
const { MiioError } = require('./miio');
const ms = require('./matter-state');

const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_INTERVAL = 5;
const CONNECT_RETRY_DELAYS_S = [10, 30, 60, 120, 300];
// Re-poll soon after a command so the Home app catches up with the robot.
const COMMAND_REFRESH_DELAYS_MS = [1500, 4000, 10000];
// How long to show the state a command asked for while the robot still reports
// the state it had before (the S5 takes a few seconds to react).
const OPTIMISTIC_TTL_MS = 15 * 1000;
const FAILURES_BEFORE_WARNING = 3;

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

class RoborockMiioPlatform {
  /**
   * @param {object} [deps]  test seam: { vacuum }
   */
  constructor(log, config, api, deps = {}) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.status = null;
    this.published = null;
    this.accessory = null;
    this.selectedAreas = [];
    this.rooms = [];
    this.fanScheme = 'codes';
    this.lastCleanKind = 'full';
    this.optimistic = null;
    this.failures = 0;
    this.pollTimer = null;
    this.refreshTimers = new Set();
    this.publishChain = Promise.resolve();
    this.stopped = false;

    if (!this.config.host || !this.config.token) {
      this.log.error('Missing "host" and/or "token" — set the robot\'s IP address and its miIO token, then restart Homebridge.');
      return;
    }

    try {
      this.vacuum = deps.vacuum || new RoborockVacuum({
        host: this.config.host,
        token: this.config.token,
      });
    } catch (err) {
      this.log.error('Invalid configuration: %s', err.message);
      return;
    }

    this.pollInterval = Math.max(MIN_POLL_INTERVAL, Number(this.config.pollInterval) || DEFAULT_POLL_INTERVAL);
    this.extendedStates = this.config.extendedStates === true;

    this.api.on('didFinishLaunching', () => {
      this.start().catch((err) => this.log.error('Startup failed: %s', err.message));
    });
    this.api.on('shutdown', () => this.shutdown());
  }

  get matter() {
    return this.api.matter;
  }

  async start() {
    const matter = this.matter;
    if (!matter) {
      this.log.error(
        'Matter is not enabled for this bridge. Run this plugin as a child bridge with Matter turned on '
        + '(in the Homebridge UI: plugin settings → Bridge Settings → enable Matter), then restart Homebridge.',
      );
      return;
    }
    if (!matter.deviceTypes || !matter.deviceTypes.RoboticVacuumCleaner) {
      this.log.error('This version of Homebridge has no Matter robotic vacuum support. Update to Homebridge 2.0 or later.');
      return;
    }

    const identity = await this.connect();
    if (!identity) return;

    this.accessory = this.buildAccessory(identity);
    this.published = this.accessory.clusters;
    this.log.info('Publishing %s as a Matter robot vacuum (%s, %d room%s)',
      this.accessory.displayName, identity.model, this.rooms.length, this.rooms.length === 1 ? '' : 's');
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
    this.log.info('Ready. If the vacuum is not in Apple Home yet, pair it with the code shown in the Homebridge UI '
      + '(plugin settings → Bridge Settings, or the Matter section of the log).');

    this.schedulePoll();
  }

  /**
   * Talk to the robot until it answers, then collect what the accessory needs.
   * Retries forever, with backoff: a robot that is off its dock or rebooting
   * should not need a Homebridge restart once it is back.
   */
  async connect() {
    for (let attempt = 0; !this.stopped; attempt += 1) {
      try {
        const status = await this.vacuum.getStatus();
        const info = await this.vacuum.getInfo().catch(() => ({}));
        const serial = await this.vacuum.getSerialNumber();
        this.status = status;
        this.fanScheme = ms.fanSchemeFor(status.fan_power);
        this.rooms = await this.resolveRooms();
        this.log.info('Connected to %s at %s (firmware %s): %s, battery %d%%',
          info.model || 'the robot', this.config.host, info.fw_ver || 'unknown', stateName(status.state), status.battery);
        return {
          deviceId: this.vacuum.deviceId,
          model: info.model || 'roborock.vacuum',
          firmware: info.fw_ver,
          serial: serial || String(this.vacuum.deviceId),
        };
      } catch (err) {
        const wait = CONNECT_RETRY_DELAYS_S[Math.min(attempt, CONNECT_RETRY_DELAYS_S.length - 1)];
        this.log.error('Cannot reach the robot at %s: %s. Retrying in %d s.', this.config.host, describeError(err), wait);
        await delay(wait * 1000);
      }
    }
    return null;
  }

  /**
   * Rooms come from the robot's saved map, which only knows segment numbers;
   * the names given in the config are matched to them by segment.
   */
  async resolveRooms() {
    const configured = Array.isArray(this.config.rooms) ? this.config.rooms : [];
    const names = new Map();
    for (const room of configured) {
      const segment = Number(room && room.segment);
      if (Number.isInteger(segment) && room.name) names.set(segment, String(room.name).slice(0, 64));
    }

    const onMap = await this.vacuum.getRooms();
    const rooms = [];
    for (const { segment } of onMap) {
      if (names.has(segment)) {
        rooms.push({ segment, name: names.get(segment) });
      } else if (this.config.unnamedRooms !== false) {
        rooms.push({ segment, name: `Room ${segment}` });
      }
    }
    for (const segment of names.keys()) {
      if (!onMap.some((room) => room.segment === segment)) {
        this.log.warn('Room %d ("%s") from the config is not on the robot\'s map — skipping it', segment, names.get(segment));
      }
    }
    if (onMap.length === 0 && names.size > 0) {
      this.log.warn('The robot reported no rooms. Room cleaning needs a saved map with rooms (set it up in the Xiaomi Home app).');
    }
    return rooms;
  }

  buildAccessory(identity) {
    const matter = this.matter;
    return {
      UUID: matter.uuid.generate(`${ACCESSORY_SEED}:${identity.deviceId}`),
      displayName: this.config.name || 'Roborock',
      deviceType: matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: identity.serial,
      manufacturer: 'Roborock',
      model: identity.model,
      ...(identity.firmware ? { firmwareRevision: String(identity.firmware) } : {}),
      context: { deviceId: identity.deviceId },
      clusters: this.currentClusters(),
      handlers: this.buildHandlers(),
    };
  }

  buildHandlers() {
    return {
      identify: {
        identify: () => this.command('locate', () => this.vacuum.findMe()),
      },
      rvcRunMode: {
        changeToMode: (request) => this.changeRunMode(request && request.newMode),
      },
      rvcOperationalState: {
        pause: () => this.pause(),
        resume: () => this.resume(),
        goHome: () => this.goHome(),
      },
      rvcCleanMode: {
        changeToMode: (request) => this.changeCleanMode(request && request.newMode),
      },
      ...(this.rooms.length > 0 ? {
        serviceArea: {
          selectAreas: (request) => this.selectAreas((request && request.newAreas) || []),
        },
      } : {}),
    };
  }

  // --- commands from the Home app ---------------------------------------------

  async changeRunMode(newMode) {
    const state = this.currentState();
    if (newMode === ms.RUN_MODE.CLEANING) {
      if (state === STATE.PAUSED) return this.resume();
      if (ms.isActive(state)) return undefined;
      return this.startCleaning();
    }
    if (newMode === ms.RUN_MODE.IDLE) {
      if (ms.isActive(state) || state === STATE.PAUSED
        || state === STATE.RETURNING_HOME || state === STATE.DOCKING) {
        return this.command('stop', () => this.vacuum.stop(), STATE.IDLE);
      }
    }
    // Anything else is left to Homebridge, which rejects unknown modes.
    return undefined;
  }

  startCleaning() {
    if (this.selectedAreas.length > 0) {
      const names = this.selectedAreas.map((id) => this.roomName(id)).join(', ');
      this.lastCleanKind = 'rooms';
      return this.command(`clean ${names}`, () => this.vacuum.cleanRooms(this.selectedAreas), STATE.SEGMENT_CLEANING);
    }
    this.lastCleanKind = 'full';
    return this.command('start a full clean', () => this.vacuum.start(), STATE.CLEANING);
  }

  pause() {
    const state = this.currentState();
    if (state === STATE.PAUSED) return undefined;
    return this.command('pause', () => this.vacuum.pause(), STATE.PAUSED);
  }

  resume() {
    if (this.currentState() !== STATE.PAUSED) {
      if (ms.isActive(this.currentState())) return undefined;
      return this.startCleaning();
    }
    if (this.lastCleanKind === 'rooms') {
      return this.command('resume the room clean', () => this.vacuum.resumeRoomClean(), STATE.SEGMENT_CLEANING);
    }
    return this.command('resume', () => this.vacuum.start(), STATE.CLEANING);
  }

  goHome() {
    const pauseFirst = ms.isActive(this.currentState());
    return this.command('return to the dock', () => this.vacuum.returnToDock({ pauseFirst }), STATE.RETURNING_HOME);
  }

  async changeCleanMode(newMode) {
    const fanPower = ms.fanPowerForMode(this.fanScheme, newMode);
    if (fanPower === undefined) return;
    await this.command(`set suction to ${fanPower}`, () => this.vacuum.setFanPower(fanPower));
    if (this.status) this.status = { ...this.status, fan_power: fanPower };
  }

  selectAreas(newAreas) {
    const unknown = newAreas.filter((id) => !this.rooms.some((room) => room.segment === id));
    if (unknown.length > 0) {
      // Homebridge's own validation answers the controller with UnsupportedArea.
      this.log.warn('Ignoring a selection of unknown room(s): %s', unknown.join(', '));
      return;
    }
    this.selectedAreas = [...new Set(newAreas)];
    this.log.info('Rooms selected: %s', this.selectedAreas.length
      ? this.selectedAreas.map((id) => this.roomName(id)).join(', ')
      : 'none (whole home)');
  }

  roomName(segment) {
    const room = this.rooms.find((candidate) => candidate.segment === segment);
    return room ? room.name : `room ${segment}`;
  }

  /**
   * Run a robot command for the Home app. On success the state the command
   * asked for is shown straight away, and the robot is polled a few times so
   * the real state follows. Errors propagate, so the Home app reports a failure.
   */
  async command(description, run, expectedState) {
    this.log.info('Home app: %s', description);
    try {
      await run();
    } catch (err) {
      this.log.error('Could not %s: %s', description, describeError(err));
      throw err;
    }
    if (expectedState !== undefined && this.status) {
      this.optimistic = {
        fromState: this.status.state,
        state: expectedState,
        until: Date.now() + OPTIMISTIC_TTL_MS,
      };
      // Not awaited: Homebridge applies the command's own state change after the
      // handler returns, and our publish should land after it.
      setImmediate(() => this.publish());
    }
    this.scheduleRefreshes();
    return undefined;
  }

  // --- state ------------------------------------------------------------------

  currentState() {
    return this.effectiveStatus().state;
  }

  /** The polled status, with any recent command's expected state laid over it. */
  effectiveStatus() {
    const status = this.status || { state: STATE.CHARGING, battery: 100, fan_power: 102 };
    const pending = this.optimistic;
    if (!pending) return status;
    if (Date.now() > pending.until || status.state !== pending.fromState) {
      this.optimistic = null;
      return status;
    }
    return { ...status, state: pending.state };
  }

  currentClusters() {
    return ms.buildClusters(this.effectiveStatus(), {
      fanScheme: this.fanScheme,
      rooms: this.rooms,
      selectedAreas: this.selectedAreas,
      extended: this.extendedStates,
    });
  }

  /** Push whatever changed since the last publish. Serialised. */
  publish() {
    const task = this.publishChain.then(async () => {
      if (!this.accessory || this.stopped) return;
      const next = this.currentClusters();
      const changes = ms.diffClusters(this.published, next);
      for (const [cluster, attributes] of Object.entries(changes)) {
        try {
          await this.matter.updateAccessoryState(this.accessory.UUID, cluster, attributes);
        } catch (err) {
          this.log.warn('Could not update %s: %s', cluster, err.message);
          continue;
        }
        this.published = { ...this.published, [cluster]: { ...this.published[cluster], ...attributes } };
      }
    });
    this.publishChain = task.catch(() => {});
    return task;
  }

  async poll() {
    let status;
    try {
      status = await this.vacuum.getStatus();
    } catch (err) {
      this.failures += 1;
      if (this.failures === FAILURES_BEFORE_WARNING) {
        this.log.warn('The robot has stopped answering: %s', describeError(err));
      } else {
        this.log.debug('Status poll failed: %s', describeError(err));
      }
      return;
    }
    if (this.failures >= FAILURES_BEFORE_WARNING) this.log.info('The robot is answering again');
    this.failures = 0;

    const previous = this.status;
    this.status = status;
    if (status.state === STATE.SEGMENT_CLEANING) this.lastCleanKind = 'rooms';
    else if (status.state === STATE.CLEANING) this.lastCleanKind = 'full';

    if (!previous || previous.state !== status.state) {
      this.log.info('Robot is %s (battery %d%%)', stateName(status.state), status.battery);
    }
    if (status.state === STATE.ERROR && (!previous || previous.error_code !== status.error_code)) {
      this.log.warn('Robot reports an error: %s', errorName(status.error_code));
    }
    await this.publish();
  }

  schedulePoll() {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, this.pollInterval * 1000);
  }

  scheduleRefreshes() {
    for (const wait of COMMAND_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.refreshTimers.delete(timer);
        this.poll().catch(() => {});
      }, wait);
      this.refreshTimers.add(timer);
    }
  }

  shutdown() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const timer of this.refreshTimers) clearTimeout(timer);
    this.refreshTimers.clear();
    if (this.vacuum) this.vacuum.close();
  }
}

function describeError(err) {
  if (err instanceof MiioError && (err.code === 'ECHECKSUM' || err.code === 'EDECRYPT')) {
    return `${err.message}. Check the token in the plugin settings`;
  }
  return err.message;
}

module.exports = { RoborockMiioPlatform };
