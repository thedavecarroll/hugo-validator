const { loadConfig, getDefaultConfig } = require('./config');
const { validate } = require('./validate');
const { init } = require('./init');
const { setupHooks } = require('./hooks');
const { doctor } = require('./doctor');
const { migrate } = require('./migrate');

module.exports = {
  loadConfig,
  getDefaultConfig,
  validate,
  init,
  setupHooks,
  doctor,
  migrate,
};
