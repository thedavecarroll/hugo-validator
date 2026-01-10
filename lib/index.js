const { loadConfig, getDefaultConfig } = require('./config');
const { validate } = require('./validate');
const { init } = require('./init');
const { setupHooks } = require('./hooks');

module.exports = {
  loadConfig,
  getDefaultConfig,
  validate,
  init,
  setupHooks,
};
