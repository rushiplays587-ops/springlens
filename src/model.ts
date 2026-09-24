export type ClassKind =
  | "controller"
  | "advice"
  | "service"
  | "repository"
  | "entity"
  | "configuration"
  | "component"
  | "other";

export interface Endpoint {
  httpMethod: string; // GET, POST, PUT, DELETE, PATCH, or "ANY" for a @RequestMapping without a method
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
  configPrefix?: string; // @ConfigurationProperties(prefix = "...") if present
  configKeys?: ConfigKeyUse[]; // @Value("${...}") placeholders read by this class
}

export interface ConfigKeyUse {
  key: string;
  hasDefault: boolean;
}

export interface ConfigProperty {
  key: string;
  value: string; // already redacted and truncated: secrets never reach the model
  redacted: boolean;
}

export interface GatewayRoute {
  id: string;
  uri: string;
  predicates: string[];
  filters: string[];
}

export interface BackendRef {
  kind: string; // e.g. "mysql", "h2", "mongodb", "redis"
  target: string; // host[:port] or in-memory name, credentials removed
  key: string; // the property it came from
}

export interface ConfigSummary {
  applicationName?: string;
  port?: string;
  contextPath?: string;
  profiles: { key: string; value: string }[]; // spring.profiles.active / default / include
  backends: BackendRef[];
  routes: GatewayRoute[];
  defaultFilters: string[];
  discoveryLocator?: string;
  discovery?: string; // Eureka service URL
  configImports: string[]; // spring.config.import and spring.cloud.config.uri
  configServer: string[]; // server-side settings (git uri, search locations)
  groups: { name: string; count: number }[]; // top-level property groups
}

export interface ConfigDocument {
  onProfile: string | null; // spring.config.activate.on-profile (or legacy spring.profiles) of this YAML document
  properties: ConfigProperty[];
  summary: ConfigSummary;
  truncated: boolean; // depth or size caps were hit
}

export interface ConfigFile {
  file: string; // path relative to the scanned repo
  format: "yaml" | "properties";
  profile: string | null; // from the file name: application-<profile>.yml
  bootstrap: boolean;
  documents: ConfigDocument[];
  error?: string; // set when the file could not be read or parsed; other files are unaffected
}

export interface Dependency {
  groupId: string;
  artifactId: string;
  version: string | null; // null when version is inherited from a parent/BOM (common in Maven)
}

export type RiskSeverity = "critical" | "advisory";

export interface RiskFinding {
  dependency: Dependency;
  severity: RiskSeverity;
  message: string;
}

export interface RepoModel {
  rootPath: string;
  classes: ClassInfo[];
  dependencies: Dependency[];
  buildFiles: string[]; // build files that were read (pom.xml, module poms, build.gradle[.kts]); empty if none found
  riskFindings: RiskFinding[];
  configs: ConfigFile[]; // application*/bootstrap* yml/yaml/properties files, values redacted
}
