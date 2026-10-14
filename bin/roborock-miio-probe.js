#!/usr/bin/env node
'use strict';

/**
 * Setup and diagnostic helper.
 *
 *   roborock-miio-probe --discover
 *   roborock-miio-probe --host 192.168.0.50 --token <32 hex chars> [action]
 *
 * Actions (default: show status and rooms):
 *   --clean-room <segment>   clean one room, to find out which segment is which
 *   --locate                 make the robot say "I'm here"
 *   --dock                   send the robot back to its dock
 *   --raw <method> [json]    call any miIO method, e.g. --raw get_consumable
 */

const { discover, MiioError } = require('../lib/miio');
const { RoborockVacuum, stateName, errorName } = require('../lib/vacuum');
const { fanSchemeFor, modeForFanPower, CLEAN_MODES } = require('../lib/matter-state');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--discover': args.discover = true; break;
      case '--host': args.host = argv[++i]; break;
      case '--token': args.token = argv[++i]; break;
      case '--clean-room': args.cleanRoom = Number(argv[++i]); break;
      case '--locate': args.locate = true; break;
      case '--dock': args.dock = true; break;
      case '--raw':
        args.raw = argv[++i];
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.rawParams = argv[++i];
        break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  roborock-miio-probe --discover
  roborock-miio-probe --host <ip> --token <token> [--clean-room <segment> | --locate | --dock | --raw <method> [json]]`);
}

async function runDiscover() {
  console.log('Looking for miIO devices on the local network...');
  const devices = await discover({ timeout: 3000 });
  if (devices.length === 0) {
    console.log('Nothing answered. The robot must be on the same network segment as this machine.');
    return;
  }
  for (const device of devices) {
    console.log(`  ${device.address.padEnd(16)} device id ${device.deviceId}`);
  }
  console.log('\nThe device id is also shown in the Xiaomi Home app (robot → ⋯ → Network info / About)');
  console.log('and next to the token in the output of token extractors, which tells you which address is the robot.');
}

async function runDevice(args) {
  const vacuum = new RoborockVacuum({ host: args.host, token: args.token, retries: 1 });
  try {
    if (args.raw) {
      const params = args.rawParams ? JSON.parse(args.rawParams) : [];
      console.log(JSON.stringify(await vacuum.call(args.raw, params), null, 2));
      return;
    }
    if (Number.isInteger(args.cleanRoom)) {
      await vacuum.cleanRooms([args.cleanRoom]);
      console.log(`Cleaning segment ${args.cleanRoom}. Watch where the robot goes, then name it in the plugin config.`);
      console.log('Send it home with --dock.');
      return;
    }
    if (args.locate) {
      await vacuum.findMe();
      console.log('Sent.');
      return;
    }
    if (args.dock) {
      const status = await vacuum.getStatus();
      await vacuum.returnToDock({ pauseFirst: status.state !== 8 && status.state !== 100 });
      console.log('Returning to the dock.');
      return;
    }

    const info = await vacuum.getInfo().catch(() => ({}));
    const status = await vacuum.getStatus();
    const serial = await vacuum.getSerialNumber();
    const rooms = await vacuum.getRooms();
    const scheme = fanSchemeFor(status.fan_power);
    const mode = CLEAN_MODES.find((entry) => entry.mode === modeForFanPower(scheme, status.fan_power));

    console.log(`Model:      ${info.model || 'unknown'}`);
    console.log(`Firmware:   ${info.fw_ver || 'unknown'}`);
    console.log(`Device id:  ${vacuum.deviceId}`);
    if (serial) console.log(`Serial:     ${serial}`);
    console.log(`State:      ${stateName(status.state)} (${status.state})`);
    console.log(`Battery:    ${status.battery}%`);
    console.log(`Suction:    ${status.fan_power} → "${mode ? mode.label : '?'}" (${scheme === 'codes' ? '101-105 codes' : 'percentage'} firmware)`);
    if (status.error_code) console.log(`Error:      ${errorName(status.error_code)} (${status.error_code})`);
    if (rooms.length === 0) {
      console.log('Rooms:      none on the saved map (room cleaning needs a saved map, set up in Xiaomi Home)');
    } else {
      console.log(`Rooms:      ${rooms.length} on the saved map — segments ${rooms.map((room) => room.segment).join(', ')}`);
      console.log('            Room names live in the Xiaomi cloud, so name them in the plugin config.');
      console.log('            Use --clean-room <segment> to see which one is which.');
    }
  } finally {
    vacuum.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.discover) return runDiscover();
  if (!args.host || !args.token) {
    usage();
    process.exitCode = 2;
    return undefined;
  }
  return runDevice(args);
}

main().catch((err) => {
  if (err instanceof MiioError && (err.code === 'ECHECKSUM' || err.code === 'EDECRYPT')) {
    console.error(`${err.message}.`);
  } else {
    console.error(err.message);
  }
  process.exitCode = 1;
});
