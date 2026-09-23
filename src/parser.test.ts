import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJavaFile, maskStrings, stripComments } from "./parser.js";

const parse = (src: string) => parseJavaFile(src, "Test.java");
const one = (src: string) => {
  const classes = parse(src);
  assert.equal(classes.length, 1, `expected 1 class, got ${classes.map((c) => c.name)}`);
  return classes[0];
};

test("maskStrings blanks literal contents but preserves length and quotes", () => {
  const src = 'String a = "}{@GetMapping"; char c = \'{\'; String t = """\n x } \n""";';
  const masked = maskStrings(stripComments(src));
  assert.equal(masked.length, src.length);
  assert.ok(!masked.includes("@GetMapping"));
  assert.ok(!masked.slice(masked.indexOf('"')).includes("}{"));
});

test("class-level @RequestMapping prefix is joined with method paths", () => {
  const c = one(`
    @RestController @RequestMapping("/api")
    class A {
      @GetMapping("/x") String x() { return ""; }
      @GetMapping String root() { return ""; }
    }`);
  assert.deepEqual(
    c.endpoints.map((e) => [e.httpMethod, e.path, e.methodName]),
    [
      ["GET", "/api/x", "x"],
      ["GET", "/api", "root"],
    ]
  );
});

test("@RequestMapping honours value=, path=, method=RequestMethod.X and path arrays", () => {
  const c = one(`
    @Controller
    class A {
      @RequestMapping(value = "/a", method = RequestMethod.POST) void a() {}
      @GetMapping(produces = "application/json", path = "/late") void b() {}
      @PostMapping({"/arr1", "/arr2"}) void c() {}
      @RequestMapping("/any") void d() {}
    }`);
  const summary = c.endpoints.map((e) => `${e.httpMethod} ${e.path} ${e.methodName}`);
  assert.deepEqual(summary, [
    "POST /a a",
    "GET /late b",
    "POST /arr1 c",
    "POST /arr2 c",
    "ANY /any d",
  ]);
});

test("a constant used as a path is reported as unresolved (empty path), not a wrong path", () => {
  const c = one(`
    @RestController
    class A { @GetMapping(Paths.USERS) void a() {} }`);
  assert.equal(c.endpoints[0].path, "");
});

test("method names survive annotated parameters, throws clauses and generic returns", () => {
  const c = one(`
    @RestController
    class A {
      @GetMapping("/u/{id}")
      public ResponseEntity<Map<String, User>> get(@PathVariable("id") Long id, @RequestParam(required = false) String q) throws Exception { return null; }
      public void other() {}
    }`);
  assert.equal(c.endpoints.length, 1);
  assert.equal(c.endpoints[0].methodName, "get");
});

test("braces and annotation-shaped text inside string literals do not break parsing", () => {
  const c = one(`
    @RestController
    class A {
      @GetMapping("/a") String a() { return "}"; }
      String note = "@GetMapping(\\"/phantom\\")";
      @GetMapping("/b") String b() { return "{"; }
    }`);
  assert.deepEqual(
    c.endpoints.map((e) => e.path),
    ["/a", "/b"]
  );
});

test("Spring Data interfaces without @Repository are classified as repositories", () => {
  const classes = parse(`
    public interface OrderRepo extends JpaRepository<Order, Long> {}
    interface NotARepo extends Comparable<String> {}`);
  assert.deepEqual(
    classes.map((c) => [c.name, c.kind]),
    [["OrderRepo", "repository"]]
  );
});

test("extra Spring roles are recognised", () => {
  const classes = parse(`
    @RestControllerAdvice class Handler {}
    @SpringBootApplication class App {}
    @MappedSuperclass class Base {}`);
  assert.deepEqual(
    classes.map((c) => [c.name, c.kind]),
    [
      ["Handler", "advice"],
      ["App", "configuration"],
      ["Base", "entity"],
    ]
  );
});

test("field injection: @Autowired with @Qualifier, @Inject, @Resource, generics", () => {
  const c = one(`
    @Service
    class S {
      @Autowired @Qualifier("x") private RepoA a;
      @Inject RepoB b;
      @Resource(name = "c") private RepoC c;
      @Autowired private List<Validator> validators;
      @Autowired private Map<String, List<Handler>> handlers;
    }`);
  assert.deepEqual([...c.dependsOn].sort(), ["Handler", "RepoA", "RepoB", "RepoC", "Validator"]);
});

test("setter injection and annotated constructor parameters", () => {
  const c = one(`
    @Service
    class S {
      @Autowired public void setA(RepoA a) {}
      public S(@Qualifier("p") RepoB b, Map<String, List<RepoC>> m, final RepoD d) throws Exception {}
    }`);
  assert.deepEqual([...c.dependsOn].sort(), ["RepoA", "RepoB", "RepoC", "RepoD"]);
});

test("Lombok @RequiredArgsConstructor injects non-static final fields without initialisers", () => {
  const c = one(`
    @Service @RequiredArgsConstructor
    class S {
      private final RepoA a;
      private final RepoB b = new RepoB();
      private static final Logger LOG = null;
      private RepoC notFinal;
    }`);
  assert.deepEqual(c.dependsOn, ["RepoA"]);
});

test("'new ClassName(...)' calls are not mistaken for a constructor", () => {
  const c = one(`
    @Service
    class S {
      Object make(Other o) { return new S(o); }
    }`);
  assert.deepEqual(c.dependsOn, []);
});

test("many annotated endpoints parse in linear-ish time", () => {
  const methods = Array.from(
    { length: 3000 },
    (_, i) => `@GetMapping("/e${i}") public String m${i}(@PathVariable("id") Long id) { return ""; }`
  ).join("\n");
  const start = Date.now();
  const c = one(`@RestController class Big {\n${methods}\n}`);
  assert.equal(c.endpoints.length, 3000);
  assert.ok(Date.now() - start < 5000, "parsing 3000 endpoints took too long");
});
