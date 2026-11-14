// Recipes are Markdown kept in modules so they ride inside every server bundle, including the
// single-file executable, with no asset copying; the dev server runs these sources directly.
import multiPovGroupEdit from "./multiPovGroupEdit.ts";

export interface VideoRecipe {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/;

/** A recipe's Markdown with its `name` and `description` frontmatter split off. */
export const parseRecipe = (markdown: string): VideoRecipe => {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) throw new Error("A recipe starts with --- frontmatter ---.");
  const fields = new Map(
    match[1]!.split("\n").flatMap((line) => {
      const colon = line.indexOf(":");
      return colon === -1 ? [] : [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]];
    }),
  );
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) throw new Error("A recipe's frontmatter has a name and description.");
  return { name, description, body: markdown.slice(match[0].length).trimEnd() };
};

export const RECIPES: ReadonlyArray<VideoRecipe> = [multiPovGroupEdit].map(parseRecipe);

/** The list as an agent reads it, or one recipe's body; `undefined` for an unknown name. */
export const recipeText = (name?: string): string | undefined => {
  if (name === undefined || name.trim() === "") {
    return RECIPES.map((recipe) => `${recipe.name}: ${recipe.description}`).join("\n");
  }
  return RECIPES.find((recipe) => recipe.name === name.trim())?.body;
};
