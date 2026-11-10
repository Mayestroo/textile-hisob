'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const ALLOWED_EXTERNAL_URLS = new Set(['https://t.me/mayestr0']);

function isAllowedAppNavigation(rawUrl, appEntryPath) {
  try {
    const candidate = new URL(rawUrl);
    if (candidate.protocol !== 'file:' || candidate.host || candidate.search || candidate.hash) return false;
    const candidatePath = path.resolve(fileURLToPath(candidate));
    const expectedPath = path.resolve(appEntryPath);
    return process.platform === 'win32'
      ? candidatePath.toLowerCase() === expectedPath.toLowerCase()
      : candidatePath === expectedPath;
  } catch {
    return false;
  }
}

function isAllowedExternalWindow(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && ALLOWED_EXTERNAL_URLS.has(parsed.toString());
  } catch {
    return false;
  }
}

function configureSecureWebContents(webContents, options = {}) {
  if (!webContents || typeof webContents.on !== 'function'
    || typeof webContents.setWindowOpenHandler !== 'function') {
    throw new TypeError('WEB_CONTENTS_REQUIRED');
  }
  const { appEntryPath, openExternal = () => Promise.resolve() } = options;
  if (typeof appEntryPath !== 'string' || !path.isAbsolute(appEntryPath)) {
    throw new TypeError('APP_ENTRY_PATH_REQUIRED');
  }

  const guardNavigation = (event, rawUrl) => {
    if (!isAllowedAppNavigation(rawUrl, appEntryPath)) event.preventDefault();
  };
  webContents.on('will-navigate', guardNavigation);
  webContents.on('will-redirect', guardNavigation);
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalWindow(url)) {
      Promise.resolve(openExternal(url)).catch(() => {});
    }
    return { action: 'deny' };
  });
}

function pathToAppEntryUrl(appEntryPath) {
  return pathToFileURL(path.resolve(appEntryPath)).href;
}

module.exports = {
  ALLOWED_EXTERNAL_URLS,
  isAllowedAppNavigation,
  isAllowedExternalWindow,
  pathToAppEntryUrl,
  configureSecureWebContents
};
