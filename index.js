'use strict';

const { PLATFORM_NAME, PLUGIN_NAME } = require('./lib/settings');
const { RoborockMiioPlatform } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RoborockMiioPlatform);
};
