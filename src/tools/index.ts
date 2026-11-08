import type { ToolDef } from "../types.js";
import { systemTools } from "./system.js";
import { networkTools } from "./network.js";
import { uciTools } from "./uci.js";
import { wifiTools } from "./wifi.js";
import { firewallTools } from "./firewall.js";
import { packageTools } from "./packages.js";
import { serviceTools } from "./services.js";
import { logTools } from "./logs.js";
import { shellTools } from "./shell.js";
import { outputTools } from "./output.js";

export const allTools: ToolDef[] = [
  ...systemTools, ...networkTools, ...uciTools, ...wifiTools,
  ...firewallTools, ...packageTools, ...serviceTools, ...logTools, ...shellTools, ...outputTools,
];
