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
  rawBody: string; // the class's body source (comments stripped) — fed to the AI narrative layer
  narrative?: string; // plain-English explanation, populated by Sprint 2's AI layer when an API key is available
}

export interface RepoModel {
  rootPath: string;
  classes: ClassInfo[];
}
