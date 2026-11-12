import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy } from "react";

import { useIsCarouselProject } from "./useIsCarouselProject";

const TimelinePanel = lazy(() => import("../timeline/TimelinePanel"));
const CarouselPanel = lazy(() => import("./CarouselPanel"));

/**
 * The project's own surface: the carousel editor for a carousel project, the timeline for a
 * video.
 */
export default function ProjectSurfacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const isCarousel = useIsCarouselProject(props.environmentId, props.workspaceRoot);
  // Until the folder has been read, neither is drawn: a carousel must not flash a timeline first.
  if (isCarousel === null) return null;
  return isCarousel ? (
    <CarouselPanel environmentId={props.environmentId} workspaceRoot={props.workspaceRoot} />
  ) : (
    <TimelinePanel {...props} />
  );
}
