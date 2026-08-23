import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import PermalinkImage from "./permalink-image";

describe("PermalinkImage zh-TW chrome", () => {
  afterEach(() => window.localStorage.clear());

  it("uses the persisted UI locale without altering generated query text", () => {
    window.localStorage.setItem("openflipbook.uiLocale", "zh-TW");
    render(
      <PermalinkImage
        nodeId="node_123456789"
        imageUrl="https://example.test/image.jpg"
        query="steam engine"
        sessionId="session_1"
      />,
    );

    expect(screen.getByRole("link", { name: "圖集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "顯示其他人的點選位置" })).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("alt")).toBe("依「steam engine」產生的插圖");
  });
});
