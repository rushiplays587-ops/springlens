import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoModel } from "./build.js";
import { ClassInfo } from "./model.js";
import { buildIndex, formatAnswer, formatLocalAnswer, queryTerms, rank, rankAll, stem, tokenize } from "./ask.js";
import { parseConfigFile } from "./config.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function cls(overrides: Partial<ClassInfo> & { name: string }): ClassInfo {
  return {
    kind: "service",
    file: `${overrides.name}.java`,
    annotations: [],
    endpoints: [],
    dependsOn: [],
    rawBody: "",
    ...overrides,
  };
}

test("tokenize splits camelCase, PascalCase, snake_case, acronyms and paths, lower-cased", () => {
  assert.deepEqual(tokenize("UserAccountService"), ["user", "account", stem("service")]);
  assert.deepEqual(tokenize("order_line_item"), ["order", stem("line"), "item"]);
  assert.deepEqual(tokenize("HTTPServer"), ["http", "server"]);
  assert.deepEqual(tokenize("/api/users/{id}"), ["api", "user", "id"]);
  assert.deepEqual(tokenize("oauth2Client"), ["oauth", "client"]);
});

test("tokenize drops Java keywords and question filler but keeps meaningful words", () => {
  assert.deepEqual(tokenize("public static void main"), ["main"]);
  assert.deepEqual(tokenize("where is the login handled"), ["login", stem("handled")]);
});

test("tokenize copes with empty and symbol-only input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("  -- ** ++ "), []);
});

test("stem joins plurals and verb forms but leaves short words and -ss/-us/-is words alone", () => {
  assert.equal(stem("users"), stem("user"));
  assert.equal(stem("handled"), stem("handle"));
  assert.equal(stem("handling"), stem("handle"));
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("address"), "address");
  assert.equal(stem("status"), "status");
  assert.equal(stem("use"), "use");
});

test("queryTerms weights typed words above synonyms and labels synonyms with the typed word", () => {
  const terms = queryTerms("which class talks to the database");
  const db = terms.find((t) => t.term === stem("database"));
  const repo = terms.find((t) => t.term === "repository");
  const entity = terms.find((t) => t.term === "entity");
  assert.equal(db?.weight, 1);
  assert.ok(repo && repo.weight < 1 && repo.display === "database");
  assert.ok(entity && repo && entity.weight < repo.weight, "entity is a weaker relation than repository");
});

test("queryTerms is empty for a question made only of noise", () => {
  assert.deepEqual(queryTerms("what is the"), []);
});

test("rank: a name match beats a body-only match", () => {
  const index = buildIndex([
    cls({ name: "ReportGenerator", rawBody: "void run() { invoice.print(); }" }),
    cls({ name: "InvoiceService", rawBody: "void run() { }" }),
  ]);
  assert.equal(rank(index, "how are invoices handled")[0].cls.name, "InvoiceService");
});

test("rank: an endpoint path match finds the controller", () => {
  const index = buildIndex([
    cls({
      name: "AlphaController",
      kind: "controller",
      endpoints: [{ httpMethod: "GET", path: "/alpha", methodName: "a" }],
    }),
    cls({
      name: "BetaController",
      kind: "controller",
      endpoints: [{ httpMethod: "POST", path: "/api/invoices/refund", methodName: "refund" }],
    }),
  ]);
  assert.equal(rank(index, "which endpoint refunds an invoice")[0].cls.name, "BetaController");
});

test("rank: a class whose exact name is in the question comes first even if others score higher", () => {
  const index = buildIndex([
    cls({ name: "Helper", rawBody: "user user user user user user user" }),
    cls({ name: "UserService", rawBody: "" }),
    cls({ name: "UserController", kind: "controller", rawBody: "user user" }),
  ]);
  assert.equal(rank(index, "what does UserService do with user")[0].cls.name, "UserService");
});

test("rank: exact name match is whole-word, so Order does not pin OrderItemRepository", () => {
  const index = buildIndex([
    cls({ name: "Order", kind: "entity" }),
    cls({ name: "OrderItemRepository", kind: "repository", rawBody: "widget widget widget widget" }),
  ]);
  assert.equal(rank(index, "widget Order")[0].cls.name, "Order");
  assert.equal(rank(index, "widget OrderItemRepository")[0].cls.name, "OrderItemRepository");
});

test("rank: questions containing regex metacharacters do not throw", () => {
  const index = buildIndex([cls({ name: "A" })]);
  assert.doesNotThrow(() => rank(index, "what does (a[ * + ? $ ^ \\ do"));
});

test("rank: class names containing regex metacharacters do not throw", () => {
  const index = buildIndex([cls({ name: "Outer$Inner" })]);
  assert.doesNotThrow(() => rank(index, "Outer$Inner"));
});

test("rank: returns nothing for a repo with no classes, no matches, or a noise-only question", () => {
  assert.deepEqual(rank(buildIndex([]), "anything"), []);
  const index = buildIndex([cls({ name: "UserService" })]);
  assert.deepEqual(rank(index, "zebra quantum"), []);
  assert.deepEqual(rank(index, "what is the"), []);
});

test("rank: honours the limit and orders ties deterministically by name", () => {
  const index = buildIndex([cls({ name: "BravoWidget" }), cls({ name: "AlphaWidget" }), cls({ name: "CharlieWidget" })]);
  const top2 = rank(index, "widget", 2);
  assert.deepEqual(top2.map((r) => r.cls.name), ["AlphaWidget", "BravoWidget"]);
  assert.deepEqual(rank(index, "widget", 0), []);
});

test("rank: reports which question words matched", () => {
  const index = buildIndex([cls({ name: "PaymentService", rawBody: "refund()" })]);
  const [top] = rank(index, "how are payments refunded");
  assert.deepEqual([...top.matched].sort(), ["payments", "refunded"]);
});

test("formatLocalAnswer says plainly no AI answer was generated and lists file, kind, endpoints, dependencies and users", () => {
  const classes = [
    cls({
      name: "OrderController",
      kind: "controller",
      file: "web/OrderController.java",
      endpoints: [{ httpMethod: "GET", path: "/orders/{id}", methodName: "get" }],
      dependsOn: ["OrderService"],
    }),
    cls({ name: "OrderService" }),
  ];
  const text = formatLocalAnswer("orders", rank(buildIndex(classes), "orders"), classes);
  assert.ok(text.includes("No AI answer was generated"));
  assert.ok(text.includes("OrderController (controller) — web/OrderController.java"));
  assert.ok(text.includes("GET /orders/{id} -> get()"));
  assert.ok(text.includes("Depends on: OrderService"));
  assert.ok(/OrderService \(service\)[\s\S]*Used by: OrderController/.test(text));
});

test("formatLocalAnswer with no results says nothing matched instead of listing classes", () => {
  const text = formatLocalAnswer("zebra", [], [cls({ name: "A" })]);
  assert.ok(text.includes("Nothing matched"));
  assert.ok(!text.includes("No AI answer was generated"));
});

test("formatLocalAnswer caps very long endpoint lists", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ httpMethod: "GET", path: `/p${i}`, methodName: `m${i}` }));
  const big = cls({ name: "BigController", kind: "controller", endpoints: many });
  const text = formatLocalAnswer("big", rank(buildIndex([big]), "big"), [big]);
  assert.ok(text.includes("(+22 more)"));
  assert.ok(!text.includes("/p29"));
});

// Behaviour on the bundled realistic inputs.
test("fixture-large: login question finds the auth classes, not the payment ones", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  const names = rank(buildIndex(model.classes), "where is user login handled").map((r) => r.cls.name);
  assert.equal(names[0], "AuthController");
  assert.ok(names.slice(0, 3).includes("AuthService"));
  assert.ok(!names.slice(0, 3).includes("PaymentController"));
});

test("fixture-large: 'which class talks to the database' returns repositories first, not controllers", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  const top3 = rank(buildIndex(model.classes), "which class talks to the database").slice(0, 3);
  assert.ok(top3.every((r) => r.cls.kind === "repository"), top3.map((r) => r.cls.name).join(","));
});

test("fixture-large: refund question finds PaymentController and PaymentService", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  const top2 = rank(buildIndex(model.classes), "how are payments refunded").slice(0, 2).map((r) => r.cls.name);
  assert.deepEqual([...top2].sort(), ["PaymentController", "PaymentService"]);
});

test("fixture-large: error-handling question finds the controller advice first", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  const [top] = rank(buildIndex(model.classes), "where do errors get turned into HTTP responses");
  assert.equal(top.cls.name, "GlobalExceptionHandler");
});

test("fixture: database question puts the repository before the entity", () => {
  const model = buildRepoModel(resolve(root, "test-fixture"));
  const names = rank(buildIndex(model.classes), "which class talks to the database").map((r) => r.cls.name);
  assert.ok(names.indexOf("UserRepository") < names.indexOf("User"), names.join(","));
});

test("queryTerms does not crash on words that are Object.prototype property names", () => {
  for (const w of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.doesNotThrow(() => queryTerms(w), w);
    assert.doesNotThrow(() => rank(buildIndex([cls({ name: "A" })]), w), w);
  }
});

test("rank: the plain lower-case word 'order' does not pin a class named Order above better matches", () => {
  const index = buildIndex([
    cls({ name: "Order", kind: "entity" }),
    cls({ name: "PipelineRunner", rawBody: "order order order" }),
  ]);
  assert.equal(rank(index, "how does the order pipeline run")[0].cls.name, "PipelineRunner");
});

test("rank: a capitalised exact class name still pins that class first", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  assert.equal(rank(buildIndex(model.classes), "what is Order used for")[0].cls.name, "Order");
});

test("rank: 'log in' (two words) finds a class about login", () => {
  const model = buildRepoModel(resolve(root, "test-fixture-large"));
  const names = rank(buildIndex(model.classes), "how do I log in").map((r) => r.cls.name);
  assert.equal(names[0], "AuthController");
});

test("formatLocalAnswer: a class that depends on itself is not listed as its own user", () => {
  const dup = cls({ name: "Dup", dependsOn: ["Dup"] });
  const text = formatLocalAnswer("dup", rank(buildIndex([dup]), "dup"), [dup]);
  assert.ok(text.includes("Used by: (no other class in this repo)"));
});

test("formatLocalAnswer: does not suggest --ai when it was already requested", () => {
  const a = cls({ name: "Thing" });
  const results = rank(buildIndex([a]), "thing");
  assert.ok(formatLocalAnswer("thing", results, [a]).includes("Pass --ai"));
  assert.ok(!formatLocalAnswer("thing", results, [a], true).includes("Pass --ai"));
});

test("rank: a class that merely mentions a repository many times does not outrank the repository", () => {
  const index = buildIndex([
    cls({
      name: "InvoiceResource",
      kind: "controller",
      dependsOn: ["InvoiceRepository"],
      rawBody: "invoiceRepository.save(); invoiceRepository.find(); ".repeat(20),
    }),
    cls({ name: "InvoiceRepository", kind: "repository", rawBody: "" }),
  ]);
  assert.equal(rank(index, "which class talks to the database")[0].cls.name, "InvoiceRepository");
});

test("queryTerms: 'stored', 'store' and 'saved' all point at repositories", () => {
  for (const q of ["where are orders stored", "where do we store orders", "where are orders saved"]) {
    assert.ok(queryTerms(q).some((t) => t.term === "repository"), q);
  }
});

test("rank: 'what endpoints exist' prefers classes that have endpoints over ones that merely mention the word", () => {
  const index = buildIndex([
    cls({ name: "EndpointLogger", kind: "component", rawBody: "" }),
    cls({
      name: "InvoiceResource",
      kind: "controller",
      endpoints: [{ httpMethod: "GET", path: "/invoices", methodName: "list" }],
    }),
    cls({ name: "InvoiceService", rawBody: "" }),
  ]);
  const names = rank(index, "what endpoints exist for invoices").map((r) => r.cls.name);
  assert.equal(names[0], "InvoiceResource");
});

test("queryTerms: joins a word with a following particle ('log in' -> login) but not with filler ('the database')", () => {
  assert.ok(queryTerms("how do I log in").some((t) => t.term === "login"));
  assert.ok(!queryTerms("which class talks to the database").some((t) => t.term === "thedatabas"));
});

// ---- config files in ask ----

const gatewayYaml = [
  "spring:",
  "  application:",
  "    name: api-gateway",
  "  cloud:",
  "    gateway:",
  "      server:",
  "        webflux:",
  "          routes:",
  "            - id: vets-service",
  "              uri: lb://vets-service",
  "              predicates:",
  "                - Path=/api/vet/**",
  "              filters:",
  "                - StripPrefix=2",
].join("\n");

function configWorld() {
  const classes = [
    cls({ name: "ApiGatewayApplication", kind: "configuration", annotations: ["SpringBootApplication"] }),
    cls({ name: "VetResource", kind: "controller", endpoints: [{ httpMethod: "GET", path: "/vets", methodName: "list" }] }),
    cls({ name: "OwnerService" }),
  ];
  const configs = [
    parseConfigFile("api-gateway/src/main/resources/application.yml", gatewayYaml),
    parseConfigFile("config-server/src/main/resources/application.yml", "server:\n  port: 8888\nspring:\n  application:\n    name: config-server\n"),
    parseConfigFile("vets/src/main/resources/application.yml", "spring:\n  application:\n    name: vets-service\n  datasource:\n    url: jdbc:mysql://vets-db.internal:3306/vets\n    password: FAKE-ASK-PASSWORD\n"),
  ];
  return { classes, configs, index: buildIndex(classes, configs) };
}

test("ask: 'how does the api gateway route requests' finds the gateway config file and prints its routes", () => {
  const { classes, configs, index } = configWorld();
  const q = "how does the api gateway route requests";
  const results = rankAll(index, q);
  const top = results[0];
  assert.equal(top.type, "config");
  assert.ok(top.type === "config" && top.config.file.startsWith("api-gateway/"));
  const text = formatAnswer(q, results, classes, false, configs.length);
  assert.ok(text.includes("vets-service -> lb://vets-service [Path=/api/vet/**, filter StripPrefix=2]"));
});

test("ask: 'which port does the config server run on' returns the config-server file and its port", () => {
  const { classes, configs, index } = configWorld();
  const q = "which port does the config server run on";
  const results = rankAll(index, q);
  assert.equal(results[0].type, "config");
  assert.ok(results[0].type === "config" && results[0].config.file.startsWith("config-server/"));
  assert.ok(formatAnswer(q, results, classes, false, configs.length).includes("Port: 8888"));
});

test("ask: a database question surfaces the config with the datasource host, and never the password", () => {
  const { classes, configs, index } = configWorld();
  const q = "which database does the vets service use";
  const text = formatAnswer(q, rankAll(index, q), classes, false, configs.length);
  assert.ok(text.includes("mysql at vets-db.internal:3306"));
  assert.ok(!text.includes("FAKE-ASK-PASSWORD"));
});

test("ask: rank() still returns classes only, so existing class-only callers are unaffected", () => {
  const { index } = configWorld();
  assert.ok(rank(index, "which port does the config server run on").every((r) => "cls" in r && r.cls.name.length > 0));
});

test("ask: a question with no config or class match says nothing matched, and formatAnswer counts config files searched", () => {
  const { classes, configs, index } = configWorld();
  const text = formatAnswer("zebra quantum", rankAll(index, "zebra quantum"), classes, false, configs.length);
  assert.ok(text.includes("Nothing matched (searched 3 classes and 3 config files)"));
});

test("ask: config classes bound by prefix or @Value show what they read in the local answer", () => {
  const c = cls({
    name: "ShopProperties",
    kind: "configuration",
    configPrefix: "shop",
    configKeys: [{ key: "shop.currency", hasDefault: true }],
  });
  const text = formatAnswer("shop properties", rankAll(buildIndex([c], []), "shop properties"), [c]);
  assert.ok(text.includes("Binds config prefix: shop"));
  assert.ok(text.includes("Reads config: shop.currency"));
});
