/**
 * Which files are media, and why one can't be, decided before ffmpeg opens it: an empty or
 * unreadable file or an unknown type otherwise fails deep in a tool with an error nobody can act on.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { STILL_PATH } from "./proxies.ts";

export const VIDEO_TYPES =
  /\.(mov|mp4|m4v|mxf|avi|mkv|mts|m2ts|webm|mpe?g|m2v|ts|3gp|wmv|flv|dv|ogv)$/i;
export const AUDIO_TYPES = /\.(wav|aiff?|mp3|m4a|aac|flac|ogg|opus|caf|wma)$/i;

const MEDIA_TYPES = [VIDEO_TYPES, AUDIO_TYPES, STILL_PATH];

/** The `._name` twin macOS writes beside each file on exFAT and network drives: never media. */
export const isAppleDouble = (file: string): boolean => /(^|[/\\])\._[^/\\]*$/.test(file);

/**
 * Why `file` can't be read as media, or null when it may be. `size` is null when the file
 * can't be opened; `types` narrows what counts, such as only videos and photos for an import.
 */
export const mediaFileProblem = (
  file: string,
  size: number | null,
  types: ReadonlyArray<RegExp> = MEDIA_TYPES,
): string | null => {
  const name = file.split(/[/\\]/).at(-1) ?? file;
  if (isAppleDouble(name)) return `${name} is a macOS resource file, not media.`;
  if (!types.some((type) => type.test(name))) {
    const extension = /\.([^.]+)$/.exec(name)?.[1];
    return extension === undefined
      ? `${name} has no file extension to tell what it is.`
      : `${name} is a .${extension} file, which isn't media Stellar reads.`;
  }
  if (size === null) return `${name} can't be read: it is missing, a folder, or not readable.`;
  if (size === 0) return `${name} is empty (0 bytes); copy it again.`;
  return null;
};

/** `mediaFileProblem` for a file on disk: it must exist, be a file, and open for reading. */
export const checkMediaFile = Effect.fn("timeline.checkMediaFile")(function* (
  file: string,
  types?: ReadonlyArray<RegExp>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs.stat(file).pipe(Effect.option);
  const readable =
    Option.isSome(stat) &&
    stat.value.type === "File" &&
    (yield* fs.access(file, { readable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ));
  return mediaFileProblem(
    path.basename(file),
    readable && Option.isSome(stat) ? Number(stat.value.size) : null,
    types,
  );
});
