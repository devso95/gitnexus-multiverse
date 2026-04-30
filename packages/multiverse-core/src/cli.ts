import { startMultiverseServer, type StartMultiverseOptions } from './index.js';

function parseArgs(argv: string[]): StartMultiverseOptions {
  const options: StartMultiverseOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--config' || arg === '-c') && next) {
      options.config = next;
      i += 1;
    } else if ((arg === '--port' || arg === '-p') && next) {
      options.port = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--host' && next) {
      options.host = next;
      i += 1;
    }
  }
  return options;
}

await startMultiverseServer(parseArgs(process.argv.slice(2)));
