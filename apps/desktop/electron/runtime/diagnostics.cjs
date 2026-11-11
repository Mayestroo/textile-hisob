'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Deliberately records only operational fields, never renderer text, URLs,
// credentials, SQL, stack traces or business payloads. One bounded prior file.
function createDiagnostics(directory, options = {}) {
  const maximumBytes = options.maximumBytes || 256 * 1024;
  const file = path.join(directory, 'desktop-events.jsonl');
  const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : undefined;
  return (event, details = {}) => {
    const record = { timestamp: new Date().toISOString(), event: token(event) || 'UNKNOWN_EVENT',
      code: token(details.code), reason: token(details.reason),
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : undefined };
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= maximumBytes) {
        if (fs.existsSync(file + '.previous')) fs.unlinkSync(file + '.previous');
        fs.renameSync(file, file + '.previous');
      }
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
      return true;
    } catch {
      // Failure to log must not hide the original startup/fatal failure.
      return false;
    }
  };
}

function installRuntimeDiagnostics({ app, processTarget = process, directory, exit = code => app.exit(code) }) {
  const record = createDiagnostics(directory);
  let terminating = false;
  const fatal = (event, error) => {
    if (terminating) return;
    terminating = true;
    record(event, { code: error?.code || error?.name || 'UNKNOWN_ERROR' });
    // Unknown main-process state must never keep accepting financial commands.
    exit(1);
  };
  processTarget.on('uncaughtException', error => fatal('MAIN_UNCAUGHT_EXCEPTION', error));
  processTarget.on('unhandledRejection', error => fatal('MAIN_UNHANDLED_REJECTION', error));
  app.on('child-process-gone', (_event, details) => record('CHILD_PROCESS_GONE', details));
  record('MAIN_STARTED');
  return record;
}
module.exports = { createDiagnostics, installRuntimeDiagnostics };
