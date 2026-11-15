/**
 * Premiere Pro on the host: whether it runs, and the app to open a project with. Creative Cloud
 * installs each release in its own folder named for its year, beside any beta:
 * `/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Where a Mac's apps are looked for. */
export const ApplicationFolders = Context.Reference<ReadonlyArray<string>>(
  "t3/videoProject/PremiereApp/ApplicationFolders",
  { defaultValue: () => ["/Applications"] },
);

const PREMIERE_APP = /^Adobe Premiere Pro\b.*\.app$/;

/** The app to use of the ones found: a release before a beta, then the newest year. */
const pickPremiereApp = (apps: ReadonlyArray<string>): string | null => {
  const named = apps.filter((app) => PREMIERE_APP.test(app.slice(app.lastIndexOf("/") + 1)));
  const year = (app: string) => Number(/(\d{4})(?!.*\d{4})/.exec(app)?.[1] ?? 0);
  const beta = (app: string) => /\bbeta\b/i.test(app.slice(app.lastIndexOf("/") + 1));
  const [best] = named.toSorted(
    (a, b) => Number(beta(a)) - Number(beta(b)) || year(b) - year(a) || a.localeCompare(b),
  );
  return best ?? null;
};

/** Premiere Pro's `.app` bundles in the application folders, in their own folders or loose. */
export const findPremiereApp = Effect.fn("PremiereApp.find")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = (folder: string) =>
    fs.readDirectory(folder).pipe(Effect.orElseSucceed((): Array<string> => []));
  const apps: Array<string> = [];
  for (const folder of yield* ApplicationFolders) {
    for (const name of yield* list(folder)) {
      if (!name.startsWith("Adobe Premiere Pro")) continue;
      const entry = path.join(folder, name);
      if (name.endsWith(".app")) apps.push(entry);
      else {
        for (const inner of yield* list(entry)) {
          if (inner.endsWith(".app")) apps.push(path.join(entry, inner));
        }
      }
    }
  }
  return pickPremiereApp(apps);
});
