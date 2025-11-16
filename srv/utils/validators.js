const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
const POLICY_ID_REGEX = /^[a-fA-F0-9]{56}$/;
const BECH32_TEST_PREFIX = /^addr_test/; // simple check for preview addresses

function isTxHash(s) {
  return typeof s === 'string' && TX_HASH_REGEX.test(s);
}

function isPolicyId(s) {
  return typeof s === 'string' && POLICY_ID_REGEX.test(s);
}

function isBech32Address(s) {
  return typeof s === 'string' && BECH32_TEST_PREFIX.test(s);
}

module.exports = { isTxHash, isPolicyId, isBech32Address };
