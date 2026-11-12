import type { OS } from "../../platform";

export function showMainTitleBar(os: OS, isDesktop: boolean): boolean {
  return !(os === "windows" && isDesktop);
}
