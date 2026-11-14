import { EnvironmentId, type VideoProjectsFolderResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { NewVideoProjectDialog } from "./NewVideoProjectDialog";

const mocks = vi.hoisted(() => ({
  projectsFolder: null as VideoProjectsFolderResult | null,
  run: vi.fn(),
  browsed: [] as Array<string>,
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    projectsFolder: () => ({ kind: "projectsFolder" }),
    createVideoProjectFromIdea: { kind: "createFromIdea" },
    createCarousel: { kind: "createCarousel" },
    createVideoProject: { kind: "createFromPremiere" },
    inspectPremiere: { kind: "inspectPremiere" },
  },
}));
vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (args: { input: { partialPath: string } }) => ({
      kind: "browse",
      partialPath: args.input.partialPath,
    }),
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; partialPath?: string } | null) => {
    const view = { error: null, isPending: false, refresh: () => {} };
    if (atom?.kind === "projectsFolder") return { ...view, data: mocks.projectsFolder };
    if (atom?.kind === "browse") {
      mocks.browsed.push(atom.partialPath!);
      return { ...view, data: { parentPath: atom.partialPath!, entries: [] } };
    }
    return { ...view, data: null };
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { kind: string }) =>
    (args: unknown): Promise<unknown> => {
      mocks.run(command.kind, args);
      return new Promise(() => {});
    },
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/state/entities", () => ({ waitForProject: () => Promise.resolve(null) }));

const environmentId = EnvironmentId.make("host");
const setup = (projectsFolder: VideoProjectsFolderResult) => {
  mocks.projectsFolder = projectsFolder;
  mocks.run.mockClear();
  mocks.browsed.length = 0;
};

it("creates from just a name in the projects folder, and Premiere browses from there", async () => {
  const folder = "/Volumes/Drive/Short-Form Projects/Project Folders";
  setup({ path: folder, exists: true, unavailable: null });
  await using screen = await render(
    <NewVideoProjectDialog environmentId={environmentId} open onOpenChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("Saved in Project Folders")).toBeVisible();
  expect(mocks.browsed).toEqual([]);

  await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "Jollibee{Enter}");
  expect(mocks.run).toHaveBeenCalledWith("createFromIdea", {
    environmentId,
    input: { title: "Jollibee" },
  });

  // The modal's inert backdrop sits over the test container, so the toggle is clicked through it.
  await screen.getByRole("button", { name: "Video from Premiere" }).click({ force: true });
  await expect
    .element(screen.getByRole("textbox", { name: "Folder or Premiere project path" }))
    .toHaveValue(`${folder}/`);
  expect(mocks.browsed).toContain(`${folder}/`);
});

it("says the projects folder's drive is unplugged and can't create there", async () => {
  setup({
    path: "/Volumes/Drive/Projects",
    exists: false,
    unavailable: "/Volumes/Drive/Projects is on Drive, which isn't connected.",
  });
  await using screen = await render(
    <NewVideoProjectDialog environmentId={environmentId} open onOpenChange={vi.fn()} />,
  );
  await expect.element(screen.getByText(/which isn't connected/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Change the projects folder" }))
    .toBeVisible();
  await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "Jollibee");
  await expect.element(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  expect(mocks.browsed).toEqual([]);
});
