function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      },
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

function preflight() {
  return json(200, {});
}

function error(statusCode, message) {
  return json(statusCode, { error: message });
}

module.exports = { json, preflight, error };
