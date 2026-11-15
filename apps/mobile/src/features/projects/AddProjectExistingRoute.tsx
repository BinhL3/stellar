import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectSourceScreen } from "./AddProjectScreen";

type AddProjectExistingRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectExistingRoute({
  route,
}: StaticScreenProps<AddProjectExistingRouteParams | undefined>) {
  return <AddProjectSourceScreen {...(route.params ?? {})} />;
}
