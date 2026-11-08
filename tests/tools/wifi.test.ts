import { describe, it, expect, vi } from "vitest";
import { wifiTools } from "../../src/tools/wifi.js";
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
function ctx(map: Record<string, string> = {}): ToolContext {
  return { ssh: { exec: vi.fn(async (_r, cmd: string) => ok(map[cmd] ?? "")) }, resolveRouter: () => router };
}
const tool = (name: string) => wifiTools.find((t) => t.name === name)!;

describe("wifi tools", () => {
  it("wifi_radios parses uci show wireless", async () => {
    const out =
      "wireless.radio0=wifi-device\nwireless.radio0.channel='36'\nwireless.default_radio0=wifi-iface\nwireless.default_radio0.ssid='MyNet'\n";
    const c = ctx({ "uci show wireless": out });
    const res = await runTool(tool("wifi_radios"), {}, c);
    expect((res.data as any).devices.radio0.channel).toBe("36");
    expect((res.data as any).interfaces.default_radio0.ssid).toBe("MyNet");
  });

  it("wifi_set_enabled stages disabled flag and reloads (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("wifi_set_enabled"), { device: "radio0", enabled: false, confirm: true }, c);
    const cmds = (c.ssh.exec as any).mock.calls.map((c2: any[]) => c2[1]);
    expect(cmds).toContain("uci set 'wireless.radio0.disabled'='1'");
    expect(cmds).toContain("wifi reload");
  });

  it("wifi_configure sets ssid/key/channel and reloads (confirmed)", async () => {
    const c = ctx();
    await runTool(tool("wifi_configure"),
      { iface: "default_radio0", ssid: "NewSSID", encryption: "psk2", key: "pass1234", confirm: true }, c);
    const cmds = (c.ssh.exec as any).mock.calls.map((c2: any[]) => c2[1]);
    expect(cmds).toContain("uci set 'wireless.default_radio0.ssid'='NewSSID'");
    expect(cmds).toContain("uci set 'wireless.default_radio0.encryption'='psk2'");
    expect(cmds).toContain("uci set 'wireless.default_radio0.key'='pass1234'");
    expect(cmds).toContain("wifi reload");
  });

  it("wifi_configure unconfirmed returns a preview", async () => {
    const c = ctx({ "uci changes": "wireless.default_radio0.ssid='NewSSID'\n" });
    const res = await runTool(tool("wifi_configure"), { iface: "default_radio0", ssid: "NewSSID" }, c);
    expect(res.preview?.risk).toBe("mutate");
    expect(res.preview?.diff).toContain("ssid");
  });
});
