// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fetchTrending } from "./trendingFetch";

const response = (body: string, status = 200) => new Response(body, { status });

describe("trending fetch", () => {
  it("uses the native transport for the actual hotboard URL and validates entries", async () => {
    const transport = vi.fn().mockResolvedValue(response(JSON.stringify({ list: [
      { title: "Real", url: "https://example.com/story" },
      { title: "Unsafe", url: "javascript:alert(1)" },
    ] })));
    expect(await fetchTrending("weibo", true, transport)).toEqual([{ title: "Real", url: "https://example.com/story" }]);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith("https://uapis.cn/api/v1/misc/hotboard?type=weibo");
  });
  it("does not silently cache malformed, upstream error or HTTP responses as empty", async () => {
    for (const body of ["not json", '{"message":"rate limited"}', '{"list":[{}]}']) {
      await expect(fetchTrending("weibo", true, async () => response(body))).rejects.toThrow();
    }
    await expect(fetchTrending("weibo", true, async () => response("", 429))).rejects.toThrow("HTTP 429");
    expect(await fetchTrending("weibo", true, async () => response('{"list":[]}'))).toEqual([]);
  });
  it("parses Product Hunt Atom and rejects HTML error pages", async () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Product</title><link rel="alternate" href="https://www.producthunt.com/products/a"/></entry></feed>';
    expect(await fetchTrending("producthunt", true, async () => response(xml))).toEqual([{ title: "Product", url: "https://www.producthunt.com/products/a" }]);
    await expect(fetchTrending("producthunt", true, async () => response("<html>blocked</html>"))).rejects.toThrow("RSS/Atom");
  });
  it("only tries the CORS proxy in browser on transport failure", async () => {
    const transport = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(response('{"list":[]}'));
    await fetchTrending("zhihu", false, transport);
    expect(transport.mock.calls[1][0]).toContain("https://api.allorigins.win/raw?url=");
    const native = vi.fn().mockRejectedValue("offline");
    await expect(fetchTrending("zhihu", true, native)).rejects.toThrow("offline");
    expect(native).toHaveBeenCalledOnce();
  });
});
