const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 minutes TTL

function get(key) {
  return cache.get(key);
}

function set(key, value, ttl) {
  return cache.set(key, value, ttl);
}

function del(key) { return cache.del(key); }

module.exports = { get, set, del };
