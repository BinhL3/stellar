import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectStartScreen } from "./AddProjectScreen";

type AddProjectSourceRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectSourceRoute({
  route,
}: StaticScreenProps<AddProjectSourceRouteParams | undefined>) {
  return <AddProjectStartScreen {...(route.params ?? {})} />;
}
