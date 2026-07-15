import { describe, expect, it } from "vitest"

describe("dynamic UI catalog", () => {
  it("loads against the installed @json-render/core API", async () => {
    const { catalogPrompt, uiCatalog } = await import("../catalog")

    expect(catalogPrompt).toContain("Card")
    expect(uiCatalog.data.components.Card.description).toBe("卡片容器，用于分组相关内容")
  })
})
