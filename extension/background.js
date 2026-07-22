let sidePanelPorts = new Set();
let isRunning = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function configureSide