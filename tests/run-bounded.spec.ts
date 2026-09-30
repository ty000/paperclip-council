import { describe, expect, it } from "vitest";
// @ts-expect-error The qualification launcher is intentionally plain ESM.
import { prepareQualificationHost } from "../scripts/qualification/run-bounded.mjs";

describe("bounded qualification launcher", () => {
  it("stops after blocked host preparation without inspecting or starting a later phase", async () => {
    const phases: string[] = [];
    await expect(prepareQualificationHost({
      run: async (command: string, args: string[], options: { timeoutMs: number }) => {
        expect(command).toBe(process.execPath);
        expect(args.at(-1)).toBe("prepare");
        phases.push(`prepare:${options.timeoutMs}`);
        throw new Error("host preparation blocked");
      },
      inspect: () => {
        phases.push("inspect");
        return { prepared: true, runtimeReady: true };
      },
      timeoutMs: 321,
      env: {},
    })).rejects.toThrow(/host preparation blocked/);
    expect(phases).toEqual(["prepare:321"]);
  });

  it("inspects the host only after successful bounded preparation", async () => {
    const phases: string[] = [];
    const host = { prepared: true, runtimeReady: true, target: "/tmp/qualified-paperclip" };
    await expect(prepareQualificationHost({
      run: async () => { phases.push("prepare"); },
      inspect: () => {
        phases.push("inspect");
        return host;
      },
      timeoutMs: 321,
      env: {},
    })).resolves.toBe(host);
    expect(phases).toEqual(["prepare", "inspect"]);
  });
});
