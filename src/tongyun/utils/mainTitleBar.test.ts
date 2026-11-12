import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { showMainTitleBar } from "./mainTitleBar";

describe("main window title bar", () => {
  it("hides only in the Windows desktop app", () => {
    expect(showMainTitleBar("windows", true)).toBe(false);
    for (const os of ["mac", "linux", "other"] as const) {
      expect(showMainTitleBar(os, true)).toBe(true);
    }
    for (const os of ["windows", "mac", "linux", "other"] as const) {
      expect(showMainTitleBar(os, false)).toBe(true);
    }
  });

  it("gates the main window title bar using the actual platform and runtime", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain("{showMainTitleBar(OS, isDesktopRuntime()) && <TitleBar />}");
  });
});
