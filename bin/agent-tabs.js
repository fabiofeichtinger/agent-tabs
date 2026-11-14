#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2));
// null: a long-running mode (host, mcp) that manages its own lifetime.
if (code !== null) process.exitCode = code;
