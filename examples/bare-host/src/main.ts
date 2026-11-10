import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { createBareHostPorts } from './ports/index.js';

/** Boots the host, prints what the slices registered with the job port, and stops. */
async function main(): Promise<void> {
  const ports = createBareHostPorts();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(ports), { logger: ['error', 'warn'] });
  const types = [...ports.jobs.registered.keys()].sort();
  console.log(`bare host: booted, ${types.length} job handlers registered: ${types.join(', ')}`);
  await app.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
