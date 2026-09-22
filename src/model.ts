export type ClassKind =
  | "controller"
  | "service"
  | "repository"
  | "entity"
  | "configuration"
  | "component"
  | "other";

export interface Endpoint {
  httpMethod: string; // GET, POST, PUT, DELETE, PATCH, or "MAPPING" if unspecified
  path: string;
  methodName: string;
}

export interface ClassInfo {
  name: string;
  kind: ClassKind;
  file: string;
  annotations: string[];
  endpoints: Endpoint[];
  dependsOn: string[]; // names of other classes referenced via @Autowired / constructor injection
}

export interface RepoModel {
  rootPath: string;
  classes: ClassInfo[];
}
