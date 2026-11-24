'use strict';

const path = require('node:path');

// Splits Copilot-branded extensions into the product-relevant groups. Matching
// the brand token, not only the GitHub publisher, catches Copilot extensions
// such as ms-vscode.vscode-copilot-vision and the Azure GitHub Copilot tools. A stock
// VS Code host may ship a built-in Copilot extension and may activate it; that
// is host wiring, not something a clean Vibecodium profile installed. Only a
// Copilot extension inside the user extensions directory is a finding for this
// product. The active list is reported so a host built-in can be disclosed.
function classifyCopilotExtensions(extensions, userExtensionsDir) {
  const list = Array.isArray(extensions) ? extensions : [];
  const copilot = list.filter(
    (candidate) => candidate && typeof candidate.id === 'string' && /copilot/i.test(candidate.id),
  );
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
