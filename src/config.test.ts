import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONFIG_FILE_BYTES,
  MAX_CONFIG_PROPERTIES,
  bindClassConfig,
  extractConfigPrefix,
  extractValueKeys,
  isConfigFileName,
  isKeyDefined,
  isPrefixDefined,
  parseConfigFile,
  parsePropertiesText,
} from "./config.js";
import { REDACTED } from "./redact.js";
import { ClassInfo } from "./model.js";

const props = (text: string, file = "application.yml") =>
  parseConfigFile(file, text).documents.flatMap((d) => d.properties.map((p) => `${p.key}=${p.value}`));

test("isConfigFileName accepts application/bootstrap files with profiles, rejects the rest", () => {
  for (const n of ["application.yml", "application.yaml", "application.properties", "application-dev.yml", "bootstrap.yml", "bootstrap-local.properties", "Application.YML"]) {
    assert.equal(isConfigFileName(n), true, n);
  }
  for (const n of ["application.yml.bak", "app.yml", "pom.xml", "application", "my-application.yml", "application.json"]) {
    assert.equal(isConfigFileName(n), false, n);
  }
});

test("parseConfigFile takes profile, bootstrap and format from the file name", () => {
  const a = parseConfigFile("svc/src/main/resources/application-dev.yml", "a: 1");
  assert.deepEqual([a.profile, a.bootstrap, a.format], ["dev", false, "yaml"]);
  const b = parseConfigFile("bootstrap.properties", "a=1");
  assert.deepEqual([b.profile, b.bootstrap, b.format], [null, true, "properties"]);
});

test("YAML: nested maps and lists flatten to dotted keys with [index] for lists", () => {
  assert.deepEqual(props("a:\n  b: 1\n  c:\n    - x\n    - y: 2\n"), ["a.b=1", "a.c[0]=x", "a.c[1].y=2"]);
});

test("YAML: a quoted key containing dots stays one key, nulls and empty values become empty strings", () => {
  assert.deepEqual(props('"logging.level.org.x": DEBUG\nempty:\nlist: []\nmap: {}\n'), [
    "logging.level.org.x=DEBUG",
    "empty=",
    "list=",
    "map=",
  ]);
});

test("YAML: anchors, aliases and merge keys resolve to their values", () => {
  const text = "base: &b\n  timeout: 5\n  retries: 2\nsvc:\n  <<: *b\n  retries: 9\n";
  assert.deepEqual(props(text), ["base.timeout=5", "base.retries=2", "svc.timeout=5", "svc.retries=9"]);
});

test("YAML: block scalars keep their text and are not split into fake keys", () => {
  const text = "banner: |\n  line one\n  key: not-a-key\nnext: folded >\n";
  const p = parseConfigFile("application.yml", "a: |\n  line one\n  b: c\nd: 1\n").documents[0].properties;
  assert.deepEqual(p.map((x) => x.key), ["a", "d"]);
  assert.ok(p[0].value.includes("b: c"));
});

test("YAML: multi-document files give one document per '---' with its own profile condition", () => {
  const cfg = parseConfigFile(
    "application.yml",
    "server:\n  port: 1\n---\nspring:\n  config:\n    activate:\n      on-profile: prod\nserver:\n  port: 2\n---\nspring:\n  profiles: legacy\nserver:\n  port: 3\n"
  );
  assert.equal(cfg.documents.length, 3);
  assert.deepEqual(cfg.documents.map((d) => d.onProfile), [null, "prod", "legacy"]);
  assert.deepEqual(cfg.documents.map((d) => d.summary.port), ["1", "2", "3"]);
});

test("summary: application name, port, context path (relaxed key spelling), profiles", () => {
  const s = parseConfigFile(
    "application.yml",
    "spring:\n  application:\n    name: shop\n  profiles:\n    active: dev,local\nserver:\n  port: 8080\n  servlet:\n    context-path: /api\n"
  ).documents[0].summary;
  assert.equal(s.applicationName, "shop");
  assert.equal(s.port, "8080");
  assert.equal(s.contextPath, "/api");
  assert.deepEqual(s.profiles, [{ key: "spring.profiles.active", value: "dev,local" }]);
  const legacy = parseConfigFile("application.yml", "server:\n  context_path: /old\n").documents[0].summary;
  assert.equal(legacy.contextPath, "/old");
});

test("summary: JDBC datasource kind and host, credentials never shown", () => {
  const s = parseConfigFile(
    "application.yml",
    "spring:\n  datasource:\n    url: jdbc:postgresql://db.internal:5432/shop?user=a&password=zzz\n    password: zzz\n"
  ).documents[0].summary;
  assert.deepEqual(s.backends, [{ kind: "postgresql", target: "db.internal:5432", key: "spring.datasource.url" }]);
  const inMem = parseConfigFile("application.properties", "spring.datasource.url=jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1\n").documents[0].summary;
  assert.deepEqual(inMem.backends.map((b) => [b.kind, b.target]), [["h2", "mem:testdb"]]);
  const withUser = parseConfigFile("application.properties", "spring.datasource.url=jdbc:mysql://root:pw@dbhost/x\n").documents[0].summary;
  assert.equal(withUser.backends[0].target, "dbhost");
});

test("summary: other backends, Eureka and config-server settings", () => {
  const s = parseConfigFile(
    "bootstrap.yml",
    [
      "spring:",
      "  data:",
      "    mongodb:",
      "      uri: mongodb://mongo.internal:27017/x",
      "    redis:",
      "      host: cache.internal",
      "  config:",
      "    import: optional:configserver:http://cfg:8888",
      "  cloud:",
      "    config:",
      "      uri: http://cfg2:8888",
      "eureka:",
      "  client:",
      "    service-url:",
      "      defaultZone: http://eureka:8761/eureka/",
    ].join("\n")
  ).documents[0].summary;
  assert.deepEqual(s.backends.map((b) => [b.kind, b.target]), [["mongodb", "mongo.internal:27017/x"], ["redis", "cache.internal"]]);
  assert.equal(s.discovery, "http://eureka:8761/eureka/");
  assert.deepEqual(s.configImports, ["optional:configserver:http://cfg:8888", "http://cfg2:8888"]);
});

test("gateway routes: shortcut and map forms, default filters, all three property paths", () => {
  const modern = [
    "spring:",
    "  cloud:",
    "    gateway:",
    "      server:",
    "        webflux:",
    "          default-filters:",
    "            - name: Retry",
    "              args:",
    "                retries: 2",
    "          routes:",
    "            - id: a",
    "              uri: lb://a",
    "              predicates:",
    "                - Path=/a/**",
    "                - name: Method",
    "                  args:",
    "                    methods: GET,POST",
    "              filters:",
    "                - StripPrefix=1",
    "            - id: b",
    "              uri: https://b.example.com",
  ].join("\n");
  const s = parseConfigFile("application.yml", modern).documents[0].summary;
  assert.deepEqual(s.routes, [
    { id: "a", uri: "lb://a", predicates: ["Path=/a/**", "Method(methods=GET,POST)"], filters: ["StripPrefix=1"] },
    { id: "b", uri: "https://b.example.com", predicates: [], filters: [] },
  ]);
  assert.deepEqual(s.defaultFilters, ["Retry(retries=2)"]);

  const legacy = "spring:\n  cloud:\n    gateway:\n      routes:\n        - id: old\n          uri: lb://old\n          predicates:\n            - Path=/old/**\n";
  assert.deepEqual(parseConfigFile("application.yml", legacy).documents[0].summary.routes.map((r) => r.id), ["old"]);

  const mvc = "spring:\n  cloud:\n    gateway:\n      server:\n        webmvc:\n          routes:\n            - id: m\n              uri: http://m\n";
  assert.deepEqual(parseConfigFile("application.yml", mvc).documents[0].summary.routes.map((r) => r.id), ["m"]);
});

test("gateway routes from a .properties file, and route text is redacted", () => {
  const s = parseConfigFile(
    "application.properties",
    "spring.cloud.gateway.routes[0].id=x\nspring.cloud.gateway.routes[0].uri=https://u:pw@backend.example.com/api\nspring.cloud.gateway.routes[0].predicates[0]=Path=/x/**\n"
  ).documents[0].summary;
  assert.equal(s.routes.length, 1);
  assert.equal(s.routes[0].uri, `https://u:${REDACTED}@backend.example.com/api`);
});

test("summary: property groups are counted by top-level prefix (two segments under spring)", () => {
  const s = parseConfigFile("application.yml", "spring:\n  jpa:\n    a: 1\n    b: 2\n  cloud:\n    c: 3\nserver:\n  port: 1\n").documents[0].summary;
  assert.deepEqual(s.groups, [
    { name: "spring.jpa", count: 2 },
    { name: "server", count: 1 },
    { name: "spring.cloud", count: 1 },
  ]);
});

test(".properties: comments, separators, continuation lines, escapes and #--- documents", () => {
  const docs = parsePropertiesText(
    [
      "# comment",
      "! also a comment",
      "a=1",
      "b : 2",
      "c 3",
      "d = spaced value  ",
      "long=one \\",
      "     two \\",
      "     three",
      "esc\\:key=v\\tw\\u0041",
      "empty=",
      "#---",
      "second=doc",
    ].join("\n")
  );
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[0].map((p) => `${p.key}=${p.value}`), ["a=1", "b=2", "c=3", "d=spaced value  ", "long=one two three", "esc:key=v\twA", "empty="]);
  assert.deepEqual(docs[1], [{ key: "second", value: "doc" }]);
});

test(".properties: an escaped trailing backslash does not continue the line", () => {
  const docs = parsePropertiesText("path=C:\\\\dir\\\\\nnext=1");
  assert.deepEqual(docs[0].map((p) => p.key), ["path", "next"]);
});

test("secrets: redacted in properties, summaries, YAML and .properties, and never present anywhere in the parsed model", () => {
  const yaml = [
    "spring:",
    "  datasource:",
    "    url: jdbc:mysql://u:FAKE-URL-PW@db:3306/x?password=FAKE-QUERY-PW",
    "    password: FAKE-PASSWORD",
    "jwt:",
    "  secret: FAKE-SECRET",
    "aws:",
    "  access-id: AKIAABCDEFGHIJKLMNOP",
    "spring.cloud.config.server.git.uri: https://deploy:FAKE-GIT-PW@git.example.com/r.git",
    "hook: https://h.example.com/x?token=FAKE-TOKEN",
    "",
  ].join("\n");
  const cfg = parseConfigFile("application.yml", yaml);
  const propsFile = parseConfigFile("application.properties", "db.password=FAKE-PROPS-PW\nurl=https://a:FAKE-PROPS-URL-PW@h/x\n");
  const dump = JSON.stringify([cfg, propsFile]);
  for (const fake of ["FAKE-URL-PW", "FAKE-QUERY-PW", "FAKE-PASSWORD", "FAKE-SECRET", "AKIAABCDEFGHIJKLMNOP", "FAKE-GIT-PW", "FAKE-TOKEN", "FAKE-PROPS-PW", "FAKE-PROPS-URL-PW"]) {
    assert.ok(!dump.includes(fake), `${fake} leaked into the parsed model`);
  }
  assert.ok(cfg.documents[0].properties.find((p) => p.key === "spring.datasource.password")?.redacted);
  assert.ok(cfg.documents[0].properties.find((p) => p.key === "jwt.secret")?.value === REDACTED);
  assert.equal(cfg.documents[0].properties.find((p) => p.key === "spring.datasource.password")?.key, "spring.datasource.password", "the key name is kept");
});

test("malformed YAML is reported as unparsable and does not throw", () => {
  for (const bad of ["a: [1, 2\nb: {", "key: value\n  bad indent: x\n\tTab: y", "- a\nb: c\n", "a: *nope"]) {
    const cfg = parseConfigFile("application.yml", bad);
    assert.ok(cfg.error, `expected an error for ${JSON.stringify(bad)}`);
  }
});

test("binary-looking content does not throw", () => {
  assert.doesNotThrow(() => parseConfigFile("application.yml", "\u0000\u0001\u0002\ufffe\uffff"));
  assert.doesNotThrow(() => parseConfigFile("application.properties", "\u0000=\u0001\n\\u12"));
});

test("a broken document does not hide the good ones in the same file", () => {
  const cfg = parseConfigFile("application.yml", "server:\n  port: 1\n---\nbroken: [1, 2\n---\nserver:\n  port: 3\n");
  assert.ok(cfg.error);
  assert.deepEqual(cfg.documents.map((d) => d.summary.port), ["1", "3"]);
});

test("empty, comment-only and scalar-only files parse to no documents without error", () => {
  for (const text of ["", "# nothing here\n", "just a string\n", "---\n---\n"]) {
    const cfg = parseConfigFile("application.yml", text);
    assert.equal(cfg.error, undefined, JSON.stringify(text));
    assert.equal(cfg.documents.length, 0);
  }
});

test("files over the size cap are skipped with a message, not parsed", () => {
  const cfg = parseConfigFile("application.yml", "a: " + "x".repeat(MAX_CONFIG_FILE_BYTES + 10));
  assert.equal(cfg.documents.length, 0);
  assert.match(cfg.error ?? "", /larger than/);
});

test("alias bombs (billion laughs) are rejected without hanging or exhausting memory", () => {
  let text = "a0: &a0 [x, x, x, x, x, x, x, x, x]\n";
  for (let i = 1; i <= 9; i++) {
    const prev = `*a${i - 1}`;
    text += `a${i}: &a${i} [${Array(9).fill(prev).join(", ")}]\n`;
  }
  const started = Date.now();
  const cfg = parseConfigFile("application.yml", text);
  assert.ok(Date.now() - started < 5000);
  assert.ok(cfg.error || cfg.documents.every((d) => d.properties.length <= MAX_CONFIG_PROPERTIES));
});

test("deeply nested YAML is cut off at the depth cap and marked truncated", () => {
  const depth = 200;
  let text = "";
  for (let i = 0; i < depth; i++) text += `${"  ".repeat(i)}k${i}:\n`;
  text += `${"  ".repeat(depth)}leaf: 1\n`;
  const cfg = parseConfigFile("application.yml", text);
  assert.ok(cfg.documents.length === 0 || cfg.documents[0].truncated || cfg.error);
});

test("a huge flat file is capped at the property limit", () => {
  const lines = Array.from({ length: MAX_CONFIG_PROPERTIES + 500 }, (_, i) => `k${i}: v`).join("\n");
  const cfg = parseConfigFile("application.yml", lines);
  assert.ok(cfg.documents[0].properties.length <= MAX_CONFIG_PROPERTIES);
  assert.equal(cfg.documents[0].truncated, true);
});

test("custom YAML tags are treated as data and never executed", () => {
  const text = "a: !!js/function 'function(){ globalThis.__pwned = true }'\nb: !custom {x: 1}\nc: !!python/object/apply:os.system ['echo hi']\n";
  const cfg = parseConfigFile("application.yml", text);
  assert.equal((globalThis as Record<string, unknown>).__pwned, undefined);
  assert.ok(cfg.documents.length >= 0);
});

test("__proto__ and constructor keys are ordinary keys and do not pollute Object", () => {
  const cfg = parseConfigFile("application.yml", "__proto__:\n  polluted: yes\nconstructor:\n  prototype:\n    x: 1\n");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.ok(Array.isArray(cfg.documents));
});

test("a very long key or value is truncated", () => {
  const cfg = parseConfigFile("application.yml", `${"k".repeat(1000)}: ${"v".repeat(1000)}\n`);
  const p = cfg.documents[0].properties[0];
  assert.ok(p.key.length <= 201);
  assert.ok(p.value.length <= 301);
});

test("extractValueKeys finds @Value placeholders with and without defaults, and never keeps the default", () => {
  const body = `
    @Value("\${a.b}") String one;
    @Value("\${c.d:hunter2}") String two;
    @Value( "\${ e.f : 30 }" ) int three;
    @Value("literal") String nope;
    @Value("#{systemProperties['x']}") String spel;
    @Value("\${a.b}") String dup;
  `;
  const keys = extractValueKeys(body);
  assert.deepEqual(keys.map((k) => [k.key, k.hasDefault]), [["a.b", false], ["c.d", true], ["e.f", true]]);
  assert.ok(!JSON.stringify(keys).includes("hunter2"));
});

test("extractConfigPrefix reads prefix=, value= and the bare string forms", () => {
  assert.equal(extractConfigPrefix('prefix = "shop"'), "shop");
  assert.equal(extractConfigPrefix('"shop.pay"'), "shop.pay");
  assert.equal(extractConfigPrefix('value = "x", ignoreUnknownFields = false'), "x");
  assert.equal(extractConfigPrefix(""), undefined);
  assert.equal(extractConfigPrefix("prefix = SOME_CONSTANT"), undefined);
});

test("isKeyDefined / isPrefixDefined use relaxed binding across all scanned files", () => {
  const cfgs = [parseConfigFile("application.yml", "notify:\n  timeout-seconds: 30\nshop:\n  free-shipping: 1\nlist:\n  - a\n")];
  assert.equal(isKeyDefined(cfgs, "notify.timeoutSeconds"), true);
  assert.equal(isKeyDefined(cfgs, "NOTIFY.TIMEOUT_SECONDS"), true);
  assert.equal(isKeyDefined(cfgs, "notify"), true);
  assert.equal(isKeyDefined(cfgs, "list"), true);
  assert.equal(isKeyDefined(cfgs, "notify.other"), false);
  assert.equal(isPrefixDefined(cfgs, "shop"), true);
  assert.equal(isPrefixDefined(cfgs, "shopping"), false);
});

test("bindClassConfig attaches @Value keys to classes that have them", () => {
  const cls: ClassInfo = {
    name: "N",
    kind: "service",
    file: "N.java",
    annotations: [],
    endpoints: [],
    dependsOn: [],
    rawBody: '@Value("${x.y:1}") int v;',
  };
  const other: ClassInfo = { ...cls, name: "O", rawBody: "" };
  bindClassConfig([cls, other]);
  assert.deepEqual(cls.configKeys, [{ key: "x.y", hasDefault: true }]);
  assert.equal(other.configKeys, undefined);
});

test("parser error messages are scrubbed: a secret quoted in a YAML error does not reach the file's error text", () => {
  const cfg = parseConfigFile("application.yml", "a: *pw?token=FAKE-ERR-SECRET-1\n");
  assert.ok(cfg.error, "expected an error");
  assert.ok(!cfg.error!.includes("FAKE-ERR-SECRET-1"), cfg.error);
});

// ---- gaps found by independent review ----

test("gateway filters and predicates that carry secrets under innocent keys are redacted (shortcut and map forms)", () => {
  const yaml = [
    "spring:",
    "  cloud:",
    "    gateway:",
    "      routes:",
    "        - id: r",
    "          uri: lb://r",
    "          predicates:",
    "            - Header=X-Token, FAKE-PRED-SECRET-1",
    "            - Query=apikey, FAKE-QUERY-SECRET-2",
    "          filters:",
    "            - AddRequestHeader=Authorization, Bearer FAKE-FILTER-SECRET-3",
    "            - AddRequestHeader=X-Api-Key, FAKE-FILTER-SECRET-4",
    "            - AddRequestHeader=X-Request-Id, harmless",
    "            - name: AddRequestHeader",
    "              args:",
    "                name: Authorization",
    "                value: FAKE-MAP-SECRET-5",
  ].join("\n");
  const cfg = parseConfigFile("application.yml", yaml);
  const dump = JSON.stringify(cfg.documents[0].summary);
  for (const n of [1, 2, 3, 4, 5]) assert.ok(!/FAKE-[A-Z]+-SECRET-/.test(dump), `secret ${n} leaked: ${dump}`);
  assert.ok(dump.includes("harmless"), "non-secret header values stay readable");
});

test("gateway routes are found under the Gateway MVC spelling spring.cloud.gateway.mvc.routes", () => {
  const s = parseConfigFile("application.yml", "spring:\n  cloud:\n    gateway:\n      mvc:\n        routes:\n          - id: m\n            uri: http://m\n").documents[0].summary;
  assert.deepEqual(s.routes.map((r) => r.id), ["m"]);
});

test("multi-datasource jdbc-url keys (hikari and named datasources) are summarised", () => {
  const s = parseConfigFile(
    "application.yml",
    "spring:\n  datasource:\n    hikari:\n      jdbc-url: jdbc:postgresql://a.internal:5432/x\n    primary:\n      jdbc-url: jdbc:mysql://b.internal/y\n"
  ).documents[0].summary;
  assert.deepEqual(s.backends.map((b) => [b.kind, b.target]), [["postgresql", "a.internal:5432"], ["mysql", "b.internal"]]);
});

test("Oracle thin URLs show the host without the credentials; IPv6 hosts survive", () => {
  const ora = parseConfigFile("application.properties", "spring.datasource.url=jdbc:oracle:thin:scott/FAKE-ORA-PW@//dbhost:1521/svc\n");
  assert.deepEqual(ora.documents[0].summary.backends.map((b) => b.target), ["dbhost:1521"]);
  assert.ok(!JSON.stringify(ora).includes("FAKE-ORA-PW"));
  const v6 = parseConfigFile("application.properties", "spring.datasource.url=jdbc:postgresql://[::1]:5432/x\n");
  assert.deepEqual(v6.documents[0].summary.backends.map((b) => b.target), ["[::1]:5432"]);
});

test("secrets in redis URLs, in keys, and under pass/pw keys never reach the parsed model", () => {
  const cfg = parseConfigFile(
    "application.properties",
    [
      "spring.data.redis.url=redis://:FAKE-REDIS-PW@redis:6379",
      "spring.datasource.pass=FAKE-PASS-1",
      "x.pw=FAKE-PW-2",
      "jdbc:x?password=FAKE-KEY-PW=v",
      "hdr=Basic RkFLRS1CQVNJQy0z",
    ].join("\n")
  );
  const dump = JSON.stringify(cfg);
  for (const fake of ["FAKE-REDIS-PW", "FAKE-PASS-1", "FAKE-PW-2", "FAKE-KEY-PW", "RkFLRS1CQVNJQy0z"]) assert.ok(!dump.includes(fake), `${fake} leaked`);
});

test("control characters in keys and values are stripped at parse time (no terminal escapes or forged lines downstream)", () => {
  const cfg = parseConfigFile("application.yml", 'a: "x\\u001b[31mred\\nforged: line"\n"k\\u001b[2Jey": v\n');
  for (const p of cfg.documents[0].properties) {
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(p.key + p.value), JSON.stringify(p));
  }
});

test("more than 50 YAML documents is reported as a limit, not as unparsable YAML, and complex keys do not print to stderr", () => {
  const cfg = parseConfigFile("application.yml", Array.from({ length: 60 }, (_, i) => `k${i}: v`).join("\n---\n"));
  assert.equal(cfg.documents.length, 50);
  assert.match(cfg.error ?? "", /^more than 50 YAML documents/);
});

test(".properties files with tens of thousands of continuation lines parse in bounded time", () => {
  const text = "a=" + Array.from({ length: 40000 }, () => "x \\").join("\n") + "\nb=1\n";
  const started = Date.now();
  const cfg = parseConfigFile("application.properties", text);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.ok(cfg.documents.length >= 0);
});

// ---- second review round ----

test("profile conditions given as YAML lists (on-profile and legacy spring.profiles) are shown", () => {
  const cfg = parseConfigFile(
    "application.yml",
    "server:\n  port: 1\n---\nspring:\n  config:\n    activate:\n      on-profile:\n        - prod\n        - eu\nserver:\n  port: 2\n---\nspring:\n  profiles:\n    - a\n    - b\nserver:\n  port: 3\n"
  );
  assert.deepEqual(cfg.documents.map((d) => d.onProfile), [null, "prod, eu", "a, b"]);
});

test("JDBC targets: ${HOST:default} placeholders stay whole, '@' in the query string is ignored, failover hosts are all listed", () => {
  const target = (url: string) =>
    parseConfigFile("application.properties", `spring.datasource.url=${url}\n`).documents[0].summary.backends[0]?.target;
  assert.equal(target("jdbc:mysql://${DB_HOST:localhost}:${DB_PORT:3306}/app"), "${DB_HOST:localhost}:${DB_PORT:3306}");
  assert.equal(target("jdbc:postgresql://h/db?options=-c%20a@b"), "h");
  assert.equal(target("jdbc:postgresql://h1:5432,h2:5432/db"), "h1:5432, h2:5432");
  assert.equal(target("jdbc:mysql://u:pw@dbhost:3306/x"), "dbhost:3306");
  assert.equal(target("jdbc:sqlserver://h:1433;databaseName=x"), "h:1433");
});

test("a Kafka bootstrap list written as a YAML list is one backend entry", () => {
  const s = parseConfigFile("application.yml", "spring:\n  kafka:\n    bootstrap-servers:\n      - k1:9092\n      - k2:9092\n").documents[0].summary;
  assert.deepEqual(s.backends.map((b) => [b.kind, b.target, b.key]), [["kafka", "k1:9092,k2:9092", "spring.kafka.bootstrap-servers"]]);
});

test("gateway predicates and filters written as a single scalar instead of a list are found", () => {
  const s = parseConfigFile(
    "application.yml",
    "spring:\n  cloud:\n    gateway:\n      routes:\n        - id: s\n          uri: lb://s\n          predicates: Path=/s/**\n          filters: StripPrefix=1\n"
  ).documents[0].summary;
  assert.deepEqual(s.routes[0].predicates, ["Path=/s/**"]);
  assert.deepEqual(s.routes[0].filters, ["StripPrefix=1"]);
});

test("secrets in the JSON-in-a-property form and key: value form never reach the parsed model", () => {
  const cfg = parseConfigFile(
    "application.properties",
    [
      'spring.application.json={"spring.datasource.password":"FAKE-APPJSON-1"}',
      "app.cfg=password: FAKE-COLON-2",
      "jdbc.address=jdbc:mysql://address=(host=h)(user=u)(password=FAKE-ADDR-3)/db",
      "mongo.url=mongodb://u:fa/ke-SLASH-4@h/db",
    ].join("\n")
  );
  const dump = JSON.stringify(cfg);
  for (const fake of ["FAKE-APPJSON-1", "FAKE-COLON-2", "FAKE-ADDR-3", "ke-SLASH-4"]) assert.ok(!dump.includes(fake), `${fake} leaked`);
});

test("a huge single-token property value parses in bounded time", () => {
  const started = Date.now();
  const cfg = parseConfigFile("application.properties", "a=" + "x".repeat(200_000) + "\nb=" + "${pass".repeat(30_000) + "\n");
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok(cfg.documents.length >= 0);
});
