/**
 * CLI command: gitnexus multiverse
 */

import { startMultiverseServer } from '../multiverse/server.js';

export const multiverseCommand = async (options: {
  port?: string;
  host?: string;
  config?: string;
}) => {
  await startMultiverseServer({
    port: options.port ? parseInt(options.port, 10) : undefined,
    host: options.host,
    config: options.config,
  });
};
