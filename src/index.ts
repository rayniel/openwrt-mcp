#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadInventory } from "./config.js";
import { createSshExecutor } from "./ssh.js";
import { buildServer } from "./server.js";
import { LocalOutputArchive } from "./output-store.js";
import { HostTrustStore } from "./host-trust.js";
import { runTrustCommand } from "./trust-cli.js";
import type { ToolContext } from "./types.js";

async function main() {
  const configPath = process.env.OPENWRT_MCP_CONFIG ?? "./openwrt-mcp.config.json";
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const inventory = loadInventory(raw);
  const [command, routerName, ...extraArgs] = process.argv.slice(2);
  if (command === "trust") {
    if (!routerName || extraArgs.length > 0) {
      throw new Error("usage: openwrt-mcp trust <router-name>");
    }
    await runTrustCommand(inventory.resolveRouter(routerName), new HostTrustStore());
    return;
  }
  if (command) throw new Error("usage: openwrt-mcp [trust <router-name>]");

  const hostTrust = new HostTrustStore();
  const outputArchive = new LocalOutputArchive();
  const ssh = createSshExecutor({ outputArchive, hostTrust });

  const ctx: ToolContext = {
    ssh,
    outputArchive,
    resolveRouter: (name) => inventory.resolveRouter(name),
  };

  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("openwrt-mcp failed to start:", err);
  process.exit(1);
});
