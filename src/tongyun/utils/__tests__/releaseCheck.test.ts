import { describe, expect, it } from "vitest";
import zh from "../../i18n/zh-CN";
import pkg from "../../../../package.json";
import tauri from "../../../../src-tauri/tauri.conf.json";
import cargo from "../../../../src-tauri/Cargo.toml?raw";
import releaseYml from "../../../../.github/workflows/release.yml?raw";
import { resolveDisplayedAppVersion } from "../updater";

describe("resolveDisplayedAppVersion", () => {
  it("prefers the installed Tauri version and strips a leading v", () => {
    expect(resolveDisplayedAppVersion("v1.2.0", "1.1.0")).toBe("1.2.0");
    expect(resolveDisplayedAppVersion("1.2.0", "1.1.0")).toBe("1.2.0");
  });

  it("falls back to the bundled package version when Tauri has not reported one", () => {
    expect(resolveDisplayedAppVersion(null, "1.1.0")).toBe("1.1.0");
    expect(resolveDisplayedAppVersion("  ", "1.1.0")).toBe("1.1.0");
  });
});

describe("check-for-updates copy", () => {
  it("tells the user they are already on the latest release", () => {
    expect(zh.settings.alreadyLatest).toBe("已是最新版本");
    expect(zh.settings.currentVersion).toBe("当前版本");
    expect(zh.settings.checkUpdate).toBe("检查更新");
  });
});

describe("release versions stay aligned", () => {
  it("keeps package.json, tauri.conf.json, and Cargo.toml on the same version", () => {
    const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
    expect(pkg.version).toBe(tauri.version);
    expect(cargoVersion).toBe(pkg.version);
  });
});

describe("release workflow", () => {
  // Releases are cut by hand so a stray tag cannot publish anything, and
  // the installers ship unsigned; both are documented in README.md.
  it("requires a manually supplied tag that already exists on the remote", () => {
    expect(releaseYml).toMatch(/workflow_dispatch:/);
    expect(releaseYml).toMatch(/inputs:\s*\n\s*tag:/);
    expect(releaseYml).toMatch(/required: true/);
    expect(releaseYml).toContain('git rev-parse -q --verify "refs/tags/$TAG"');
    expect(releaseYml).not.toMatch(/push:\s*\n\s*tags:/);
  });

  it("builds every desktop bundle for the tag it was given", () => {
    for (const args of ["--bundles deb,rpm,appimage", "--bundles app,dmg", "--bundles nsis"]) {
      expect(releaseYml).toContain(args);
    }
    expect(releaseYml).toContain("ref: ${{ inputs.tag }}");
  });
});
