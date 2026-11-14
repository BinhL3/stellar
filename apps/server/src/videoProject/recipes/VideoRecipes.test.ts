import { describe, expect, it } from "@effect/vitest";

import { VideoToolkit } from "../../mcp/toolkits/video/tools.ts";
import { parseRecipe, RECIPES, recipeText } from "./VideoRecipes.ts";

describe("video recipes", () => {
  it("each has a unique name and a description, and names only tools that exist", () => {
    const names = RECIPES.map((recipe) => recipe.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const recipe of RECIPES) {
      expect(recipe.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(recipe.description.length).toBeGreaterThan(0);
      expect(recipe.body).not.toMatch(/^---/);
      const cited = new Set(recipe.body.match(/\bvideo_[a-z_]+/g));
      expect([...cited].filter((tool) => !(tool in VideoToolkit.tools))).toEqual([]);
    }
  });

  it("lists every recipe without a name and returns one by name", () => {
    expect(recipeText()).toBe(
      RECIPES.map((recipe) => `${recipe.name}: ${recipe.description}`).join("\n"),
    );
    expect(recipeText(" multi-pov-group-edit ")).toMatch(/^# Multi-POV group edit\n/);
    expect(recipeText("no-such-recipe")).toBeUndefined();
  });

  it("refuses Markdown without name and description frontmatter", () => {
    expect(() => parseRecipe("# No frontmatter")).toThrow();
    expect(() => parseRecipe("---\nname: only-a-name\n---\nBody")).toThrow();
  });
});
