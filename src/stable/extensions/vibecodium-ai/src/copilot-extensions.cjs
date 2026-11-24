'use strict';

const path = require('node:path');

// Splits GitHub Copilot extensions into the product-relevant groups. A stock
// VS Code host may ship a built-in Copilot extension and may activate it; that
// is host wiring, not something a clean Vibecodium profile installed. Only a
// Copilot extension inside the user extensions directory is a finding for this
// product. The active list is reported so a host built-in can be disclosed.
function classifyCopilotExtensions(extensions, userExtensionsDir) {
  const list = Array.isArray(extensions) ? extensions : [];
  const copilot = list.filter((candidate) => candidate && /^GitHub\.copilot(?:-|$)/i.test(candidate.id));
  const root = userExtensionsDir
    ? path.resolve(userExtensionsDir).toLowerCase() + path.sep
    : null;
  const userInstalled = copilot.filter((candidate) => {
    if (!root || typeof candidate.extensionPath !== 'string') return true;
    return path.resolve(candidate.extensionPath).toLowerCase().startsWith(root);
  });
  const active = copilot.filter((candidate) => candidate.isActive === true);
  const activeUserInstalled = userInstalled.filter((candidate) => candidate.isActive === true);
  return { copilot, userInstalled, active, activeUserInstalled };
}

module.exports = { classifyCopilotExtensions };
