let modulePromise;

function loadHttpClientModule() {
  if (!modulePromise) {
    modulePromise = import('./httpClient.js');
  }
  return modulePromise;
}

async function fetchWithRetry(url, options = {}, config = {}) {
  const module = await loadHttpClientModule();
  return module.fetchWithRetry(url, options, config);
}

async function postDiscordOrThrow(params) {
  const module = await loadHttpClientModule();
  return module.postDiscordOrThrow(params);
}

module.exports = {
  fetchWithRetry,
  postDiscordOrThrow
};
