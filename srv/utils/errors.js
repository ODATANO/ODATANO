function mapProviderError(err) {
  // defaults
  let status = 500;
  let message = err && err.message ? err.message : String(err);

  // HTTP error handling
  if (err && err.response && err.response.status) {
    status = err.response.status;
    // try to extract helpful message
    message = err.response.data && (err.response.data.error || err.response.data.message)
      ? (err.response.data.error || err.response.data.message)
      : `Provider returned HTTP ${status}`;
  }

  // timeouts / network errors
  if (err && (err.code === 'ECONNABORTED' || message.toLowerCase().includes('timed out') || message.toLowerCase().includes('timeout'))) {
    status = 503;
    message = 'Provider timeout or unreachable';
  }

  // Custom NOT_FOUND token from adapters
  if (message === 'NOT_FOUND' || message.toUpperCase() === 'NOT_FOUND') {
    status = 404;
    message = 'Not found';
  }

  // Unauthorized detection
  if (status === 401 || /unauthor/i.test(message)) {
    status = 401;
    message = 'Unauthorized access to provider';
  }

  return { status, message };
}

module.exports = { mapProviderError };
