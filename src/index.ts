#!/usr/bin/env node

import { program } from "commander";
import { registerCommands } from "./cli.js";

program
  .name("msam")
  .description("Multi-Stream Adaptive Memory — cognitive memory architecture for AI agents")
  .version("2026.4.3");

registerCommands(program);

program.parse();
