import { afterEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createSshExecutor } from "../src/ssh.js";
import { createMemoryCapture } from "../src/output-store.js";
import type { RouterConfig } from "../src/types.js";

const router: RouterConfig = {
  name: "home", host: "h", port: 22, username: "root",
  auth: { type: "password", password: "pw" }, readonly: false, default: true,
};
const hostTrust = {
  get: async () => ({ fingerprint: `SHA256:${"A".repeat(43)}` }),
};

function executor(connect: () => any) {
  return createSshExecutor({ connect, hostTrust });
}

// Fake ssh2 Client: emits "ready" on connect, streams a canned result on exec.
function fakeClient(stdout: string, stderr: string, code: number) {
  const client: any = new EventEmitter();
  client.connect = (_opts: any) => queueMicrotask(() => client.emit("ready"));
  client.end = vi.fn();
  client.exec = (_cmd: string, cb: (e: Error | undefined, stream: any) => void) => {
    const stream: any = new EventEmitter();
    stream.stderr = new EventEmitter();
    cb(undefined, stream);
    queueMicrotask(() => {
      if (stdout) stream.emit("data", Buffer.from(stdout));
      if (stderr) stream.stderr.emit("data", Buffer.from(stderr));
      stream.emit("close", code);
    });
  };
  return client;
}

afterEach(() => vi.useRealTimers());

describe("createSshExecutor", () => {
  it("runs a command and returns stdout/stderr/code", async () => {
    const connect = vi.fn(() => fakeClient("hello\n", "", 0));
    const ssh = executor(connect);
    const res = await ssh.exec(router, "echo hello");
    expect(res).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      status: "completed",
      dispatchState: "dispatched",
    });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("captures stderr and non-zero exit code", async () => {
    const ssh = executor(() => fakeClient("", "nope\n", 2));
    const res = await ssh.exec(router, "false");
    expect(res.stderr).toBe("nope\n");
    expect(res.code).toBe(2);
    expect(res.status).toBe("completed");
  });

  it("passes password auth in connect options", async () => {
    let opts: any;
    const connect = vi.fn(() => {
      const c = fakeClient("", "", 0);
      const orig = c.connect;
      c.connect = (o: any) => { opts = o; orig(o); };
      return c;
    });
    const ssh = executor(connect);
    await ssh.exec(router, "true");
    expect(opts).toMatchObject({ host: "h", port: 22, username: "root", password: "pw" });
  });

  it("rejects when the connection errors", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("error", new Error("ECONNREFUSED")));
      c.end = vi.fn();
      return c;
    };
    const ssh = executor(connect);
    await expect(ssh.exec(router, "true")).resolves.toMatchObject({
      status: "connection_error",
      code: null,
      dispatchState: "not_dispatched",
      error: "ECONNREFUSED",
    });
  });

  it("distinguishes authentication failure", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => {
        const err: any = new Error("All configured authentication methods failed");
        err.level = "client-authentication";
        c.emit("error", err);
      });
      c.end = vi.fn();
      return c;
    };
    const ssh = executor(connect);
    await expect(ssh.exec(router, "true")).resolves.toMatchObject({
      status: "authentication_error",
      code: null,
      dispatchState: "not_dispatched",
    });
  });

  it("times out a hung command", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.exec = (_cmd: string, cb: any) => {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream); // never emits "close" — triggers timeout
      };
      c.end = vi.fn();
      return c;
    };
    const ssh = executor(connect);
    const res = await ssh.exec(router, "sleep 999", { timeoutMs: 20 });
    expect(res).toMatchObject({
      status: "timeout",
      code: null,
      dispatchState: "dispatched",
    });
  });

  it("retains partial output on timeout and reports unknown exit status", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.exec = (_cmd: string, cb: any) => {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        queueMicrotask(() => stream.emit("data", Buffer.from("partial")));
      };
      c.end = vi.fn();
      return c;
    };
    const res = await executor(connect).exec(router, "sleep", { timeoutMs: 20 });
    expect(res).toMatchObject({
      stdout: "partial",
      code: null,
      status: "timeout",
      dispatchState: "dispatched",
    });
  });

  it("settles timeout before synchronous channel close and ignores all later output", async () => {
    vi.useFakeTimers();
    const stream: any = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.resume = vi.fn();
    stream.stderr.resume = vi.fn();
    stream.close = vi.fn(() => {
      stream.emit("data", Buffer.from("during close"));
      stream.stderr.emit("data", Buffer.from("during stderr close"));
      stream.emit("exit", 0);
      stream.emit("close", 0);
    });
    const client = fakeClient("", "", 0);
    client.exec = vi.fn((_cmd: string, cb: any) => {
      cb(undefined, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("before timeout"));
        stream.stderr.emit("data", Buffer.from("warning"));
      });
    });
    const connect = vi.fn(() => client);
    const capture = createMemoryCapture("not_configured");
    const append = vi.spyOn(capture, "append");
    const finish = vi.spyOn(capture, "finish");
    const ssh = createSshExecutor({
      connect,
      hostTrust,
      outputArchive: {
        createCapture: async () => capture,
        read: async () => { throw new Error("not used"); },
      },
    });
    const pending = ssh.exec(router, "long-running", { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toMatchObject({
      stdout: "before timeout",
      stderr: "warning",
      status: "timeout",
      code: null,
      dispatchState: "dispatched",
      outputPartial: true,
    });
    stream.emit("data", Buffer.from("after finalization"));
    stream.stderr.emit("data", Buffer.from("after stderr finalization"));
    expect(append).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(client.exec).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("discards late exec channels without sending stdin or replaying the timed-out command", async () => {
    vi.useFakeTimers();
    let lateCallback!: (err: Error | undefined, channel: any) => void;
    const client = fakeClient("next output", "", 0);
    const normalExec = client.exec;
    client.exec = vi.fn()
      .mockImplementationOnce((_cmd: string, cb: typeof lateCallback) => { lateCallback = cb; })
      .mockImplementation(normalExec);
    const connect = vi.fn(() => client);
    const capture = createMemoryCapture("not_configured");
    const append = vi.spyOn(capture, "append");
    const finish = vi.spyOn(capture, "finish");
    const ssh = createSshExecutor({
      connect,
      hostTrust,
      outputArchive: {
        createCapture: vi.fn()
          .mockResolvedValueOnce(capture)
          .mockImplementation(async () => createMemoryCapture("not_configured")),
        read: async () => { throw new Error("not used"); },
      },
    });
    const pending = ssh.exec(router, "sh -s", { timeoutMs: 20, stdin: "reboot\n" });
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toMatchObject({
      status: "timeout",
      code: null,
      dispatchState: "possibly_dispatched",
      stdout: "",
      outputPartial: true,
    });
    const lateChannel: any = new EventEmitter();
    lateChannel.stderr = new EventEmitter();
    lateChannel.end = vi.fn();
    lateChannel.resume = vi.fn(() => lateChannel.emit("data", Buffer.from("discard stdout")));
    lateChannel.stderr.resume = vi.fn(() =>
      lateChannel.stderr.emit("data", Buffer.from("discard stderr")),
    );
    lateChannel.close = vi.fn(() => lateChannel.emit("close", 0));
    lateCallback(undefined, lateChannel);
    lateChannel.emit("data", Buffer.from("more discarded output"));
    expect(lateChannel.close).toHaveBeenCalledOnce();
    expect(lateChannel.resume).toHaveBeenCalledOnce();
    expect(lateChannel.stderr.resume).toHaveBeenCalledOnce();
    expect(lateChannel.end).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
    expect(client.exec).toHaveBeenCalledOnce();

    const next = await ssh.exec(router, "next");
    expect(next).toMatchObject({ status: "completed", stdout: "next output", code: 0 });
    expect(connect).toHaveBeenCalledOnce();
    expect(client.exec.mock.calls.map(([command]: [string]) => command)).toEqual(["sh -s", "next"]);
  });

  it("does not invent exit code zero when ssh2 omits it", async () => {
    const ssh = executor(() => fakeClient("", "", undefined as unknown as number));
    const res = await ssh.exec(router, "true");
    expect(res.code).toBeNull();
    expect(res.status).toBe("completed");
  });

  it("preserves a termination signal with an unknown exit code", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.end = vi.fn();
      c.exec = (_cmd: string, cb: any) => {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        queueMicrotask(() => {
          stream.emit("exit", undefined, "SIGTERM");
          stream.emit("close", undefined, "SIGTERM");
        });
      };
      return c;
    };
    const res = await executor(connect).exec(router, "terminated");
    expect(res).toMatchObject({ code: null, signal: "SIGTERM", status: "completed" });
  });

  it("keeps a dispatched command marked interrupted if the connection drops", async () => {
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.exec = (_cmd: string, cb: any) => {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("before disconnect"));
          c.emit("close");
        });
      };
      c.end = vi.fn();
      return c;
    };
    const res = await executor(connect).exec(router, "long-running");
    expect(res).toMatchObject({
      stdout: "before disconnect",
      code: null,
      status: "interrupted",
      dispatchState: "dispatched",
    });
  });

  it("reuses a trusted SSH connection for independent exec channels", async () => {
    let connects = 0;
    let commands = 0;
    const connect = () => {
      connects += 1;
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.end = vi.fn();
      c.exec = (_cmd: string, cb: any) => {
        commands += 1;
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        queueMicrotask(() => stream.emit("close", 0));
      };
      return c;
    };
    const ssh = executor(connect);
    await ssh.exec(router, "first");
    await ssh.exec(router, "second");
    expect(connects).toBe(1);
    expect(commands).toBe(2);
  });

  it("does not replay a dispatched command after a connection loss", async () => {
    let commands = 0;
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.end = vi.fn();
      c.exec = (_cmd: string, cb: any) => {
        commands += 1;
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        queueMicrotask(() => c.emit("close"));
      };
      return c;
    };
    const res = await executor(connect).exec(router, "reboot");
    expect(commands).toBe(1);
    expect(res).toMatchObject({
      status: "interrupted",
      dispatchState: "dispatched",
      code: null,
    });
  });

  it("refuses an SSH host key that differs from local trust", async () => {
    let commandCount = 0;
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = (opts: any) => queueMicrotask(() => {
        const accepted = opts.hostVerifier(`SHA256:${"B".repeat(43)}`);
        if (!accepted) c.emit("error", new Error("Host key verification failed"));
        else c.emit("ready");
      });
      c.end = vi.fn();
      c.exec = () => { commandCount += 1; };
      return c;
    };
    const res = await executor(connect).exec(router, "true");
    expect(res.status).toBe("host_key_mismatch");
    expect(commandCount).toBe(0);
    expect(res.error).toMatch(/host key/i);
  });

  it("explains how to trust a router with no saved host key", async () => {
    let connects = 0;
    const res = await createSshExecutor({
      connect: () => {
        connects += 1;
        return fakeClient("", "", 0);
      },
      hostTrust: { get: async () => ({ reason: "host key has not been trusted" }) },
    }).exec(router, "true");
    expect(connects).toBe(0);
    expect(res.status).toBe("host_untrusted");
    expect(res.error).toContain('openwrt-mcp trust "home"');
  });

  it("writes the exact script text to the SSH channel stdin", async () => {
    let stdin = "";
    const connect = () => {
      const c: any = new EventEmitter();
      c.connect = () => queueMicrotask(() => c.emit("ready"));
      c.end = vi.fn();
      c.exec = (_cmd: string, cb: any) => {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.end = (value: string) => { stdin = value; };
        cb(undefined, stream);
        queueMicrotask(() => stream.emit("close", 0));
      };
      return c;
    };
    const script = "cd /tmp\nprintf '%s\\n' 'héllo'\n";
    await executor(connect).exec(router, "sh -s", { stdin: script });
    expect(stdin).toBe(script);
  });

  it("surfaces archive setup failures without discarding captured command output", async () => {
    const connect = () => fakeClient("visible", "", 0);
    const ssh = createSshExecutor({
      connect,
      hostTrust,
      outputArchive: {
        createCapture: async () => { throw new Error("disk full"); },
        read: async () => { throw new Error("not used"); },
      },
    });
    const res = await ssh.exec(router, "echo visible");
    expect(res.stdout).toBe("visible");
    expect(res.status).toBe("completed");
    expect(res.archiveStatus).toBe("failed");
    expect(res.archiveError).toContain("disk full");
  });
});
