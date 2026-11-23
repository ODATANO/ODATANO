#!/usr/bin/env node
// The image's schema deploy: the same command a plugin project runs.
import { runDeploySchemaCli } from '../scripts/deploy-schema.mjs';

await runDeploySchemaCli();
