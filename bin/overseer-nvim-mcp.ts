#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../src/server.js";

await buildServer().connect(new StdioServerTransport());
