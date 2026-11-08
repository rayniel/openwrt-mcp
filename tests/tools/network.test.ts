import { describe, it, expect, vi } from "vitest";
import { networkTools } from "../../src/tools/network.js";
import { runTool } from "../../src/safety.js";
import type { ToolContext, RouterConfig, CommandResult } from "../../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "x" }, readonly: false, default: true,
};
const ok = (s: string): CommandResult => ({
  stdout: s, stderr: "", code: 0, signal: null, durationMs: 1,
  status: "completed", dispatchState: "dispatched",
  stdoutBytes: Buffer.byteLength(s), stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, outputPartial: false,
  archiveStatus: "not_configured",
});
function ctx(map: Record<string, string>): ToolContext {
  return { ssh: { exec: vi.fn(async (_r, cmd: string) => ok(map[cmd] ?? "")) }, resolveRouter: () => router };
}
const tool = (name: string) => networkTools.find((t) => t.name === name)!;

describe("network tools", () => {
  it("net_dhcp_leases parses /tmp/dhcp.leases", async () => {
    const leases = "1718000000 aa:bb:cc:dd:ee:ff 192.168.1.50 laptop 01:aa:bb:cc:dd:ee:ff\n";
    const c = ctx({ "cat /tmp/dhcp.leases 2>/dev/null || true": leases });
    const res = await runTool(tool("net_dhcp_leases"), {}, c);
    expect(res.data).toEqual([
      { expires: 1718000000, mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.50", hostname: "laptop", clientId: "01:aa:bb:cc:dd:ee:ff" },
    ]);
  });

  it("net_arp parses /proc/net/arp", async () => {
    const arp = "IP address       HW type     Flags       HW address            Mask     Device\n" +
                "192.168.1.50     0x1         0x2         aa:bb:cc:dd:ee:ff     *        br-lan\n";
    const c = ctx({ "cat /proc/net/arp": arp });
    const res = await runTool(tool("net_arp"), {}, c);
    expect(res.data).toEqual([{ ip: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff", device: "br-lan" }]);
  });

  it("net_interfaces returns parsed ubus json", async () => {
    const dump = JSON.stringify({ interface: [{ interface: "lan", up: true, proto: "static" }] });
    const c = ctx({ "ubus call network.interface dump": dump });
    const res = await runTool(tool("net_interfaces"), {}, c);
    expect((res.data as any)[0]).toMatchObject({ name: "lan", up: true, proto: "static" });
  });
});
