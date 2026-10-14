'use strict';

module.exports = {
  /** Must match the "name" in package.json — Homebridge identifies plugins by it. */
  PLUGIN_NAME: 'homebridge-roborock-miio-matter',

  PLATFORM_NAME: 'RoborockMiio',

  /**
   * Seed for the generated accessory UUID.
   *
   * Deliberately a fixed string rather than PLUGIN_NAME: the UUID also keys
   * the vacuum's Matter pairing, so deriving it from the package name would
   * make a rename drop the vacuum from Apple Home. Never change this.
   */
  ACCESSORY_SEED: 'homebridge-roborock-miio-matter',
};
