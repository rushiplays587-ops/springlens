import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VALUE_CHARS, REDACTED, isSecretKey, redactText, redactValue } from "./redact.js";

test("isSecretKey flags password/secret/token/key/credential/private/auth-ish keys, in any segment and any case", () => {
  for (const k of [
    "spring.datasource.password",
    "spring.datasource.PASSWORD",
    "jwt.secret",
    "app.api-key",
    "app.apiKey",
    "cloud.aws.credentials.access-key",
    "github.token",
    "server.ssl.key-store-password",
    "security.oauth2.client.registration.google.client-secret",
    "app.private-key-path",
    "spring.security.user.passwd",
    "db.pwd",
    "x.password.hint",
    "service.auth.header",
  ]) {
    assert.equal(isSecretKey(k), true, k);
  }
});

test("isSecretKey leaves ordinary keys alone", () => {
  for (const k of ["server.port", "spring.application.name", "spring.datasource.url", "logging.level.root", "shop.currency"]) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test("redactValue removes the value under a secret-looking key but keeps a bare ${ENV} placeholder", () => {
  assert.deepEqual(redactValue("spring.datasource.password", "hunter2"), { value: REDACTED, redacted: true });
  assert.deepEqual(redactValue("jwt.secret", "${JWT_SECRET}"), { value: "${JWT_SECRET}", redacted: false });
  assert.deepEqual(redactValue("jwt.secret", "${JWT_SECRET:changeme}"), { value: REDACTED, redacted: true });
  assert.deepEqual(redactValue("db.password", ""), { value: "", redacted: false });
});

test("redactValue strips URL credentials whatever the key is called", () => {
  const r = redactValue("spring.cloud.config.server.git.uri", "https://deploy:s3cr3t@git.example.com/org/repo.git");
  assert.equal(r.value, `https://deploy:${REDACTED}@git.example.com/org/repo.git`);
  assert.equal(r.redacted, true);
  assert.ok(!r.value.includes("s3cr3t"));
});

test("redactText strips secret-looking query and JDBC parameters but keeps the rest of the URL", () => {
  assert.equal(
    redactText("jdbc:mysql://db:3306/shop?useSSL=false&password=hunter2&user=app"),
    `jdbc:mysql://db:3306/shop?useSSL=false&password=${REDACTED}&user=app`
  );
  assert.equal(
    redactText("jdbc:sqlserver://h:1433;databaseName=x;password=abc;user=u"),
    `jdbc:sqlserver://h:1433;databaseName=x;password=${REDACTED};user=u`
  );
  assert.equal(redactText("https://x.example.com/hook?token=abc123&debug=1"), `https://x.example.com/hook?token=${REDACTED}&debug=1`);
  assert.equal(redactText("password=abc"), `password=${REDACTED}`);
});

test("redactText redacts the default inside a secret-named placeholder but not the name", () => {
  assert.equal(redactText("${DB_PASSWORD:changeme}"), `\${DB_PASSWORD:${REDACTED}}`);
  assert.equal(redactText("${SERVER_HOST:localhost}"), "${SERVER_HOST:localhost}");
});

test("redactText catches well-known token shapes anywhere in a value", () => {
  const fakes = [
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnopq",
    "glpat-abcdefghij0123456789",
    "xoxb-1234567890-abcdefghij",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-",
  ];
  for (const f of fakes) {
    const out = redactText(`prefix ${f} suffix`);
    assert.ok(!out.includes(f), `${f} leaked: ${out}`);
    assert.ok(out.includes(REDACTED));
  }
});

test("redactText removes a PEM private key block, including an unterminated one", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactText(`key: ${pem} tail`).includes("MIIEow"), false);
  assert.equal(redactText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC").includes("MIIEvQ"), false);
});

test("redactText blanks long mixed letter/digit runs (hashes, opaque keys) but not class names, paths or hosts", () => {
  assert.equal(redactText("d41d8cd98f00b204e9800998ecf8427e"), REDACTED);
  assert.equal(redactText("com.example.demo.SomeVeryLongClassNameThatIsLongerThanThirtyTwoChars"), "com.example.demo.SomeVeryLongClassNameThatIsLongerThanThirtyTwoChars");
  assert.equal(redactText("lb://vets-service"), "lb://vets-service");
  assert.equal(redactText("/api/vet/**"), "/api/vet/**");
  assert.equal(redactText("jdbc:mysql://db.internal:3306/petclinic"), "jdbc:mysql://db.internal:3306/petclinic");
});

test("redactValue truncates last: a cut can never expose part of a secret that was caught first", () => {
  const long = "https://u:" + "p".repeat(400) + "@h.example.com/x";
  const r = redactValue("some.url", long);
  assert.ok(r.value.length <= MAX_VALUE_CHARS + 1);
  assert.ok(!r.value.includes("pppp"));
});

test("redactValue is idempotent, so re-redacting for a prompt changes nothing", () => {
  for (const [k, v] of [
    ["a.password", "x"],
    ["b.url", "https://u:pw@h/x?token=t"],
    ["c.plain", "hello"],
  ]) {
    const once = redactValue(k, v).value;
    assert.equal(redactValue(k, once).value, once);
  }
});

// ---- gaps found by independent review ----
import { redactRouteArgs, stripControls } from "./redact.js";

test("URL credentials: empty user (redis), passwords containing @, lone token userinfo, and Oracle thin user/password@host", () => {
  assert.equal(redactText("redis://:hunter2@redis:6379"), `redis://:${REDACTED}@redis:6379`);
  assert.equal(redactText("mongodb://u:hu@nter@h/db"), `mongodb://u:${REDACTED}@h/db`);
  assert.equal(redactText("https://abc123tokenX@github.com/x.git"), `https://${REDACTED}@github.com/x.git`);
  assert.equal(redactText("ssh://git@github.com/x.git"), "ssh://git@github.com/x.git");
  assert.equal(redactText("jdbc:oracle:thin:scott/hunter2@//h:1521/x"), `jdbc:oracle:thin:scott/${REDACTED}@//h:1521/x`);
  assert.equal(redactText("jdbc:oracle:thin:scott/hunter2@h:1521:orcl"), `jdbc:oracle:thin:scott/${REDACTED}@h:1521:orcl`);
});

test("URLs with an @ later in the path or a plain host:port are not mangled", () => {
  assert.equal(redactText("http://host:8080/users"), "http://host:8080/users");
  assert.equal(redactText("lb://vets-service"), "lb://vets-service");
});

test("secret words: pass, pw, pwd and friends in keys, query parameters and placeholder defaults", () => {
  for (const k of ["spring.datasource.pass", "x.pw", "app.dbpass", "app.db-pwd"]) assert.equal(isSecretKey(k), true, k);
  assert.equal(redactText("jdbc:mysql://h/x?pass=hunter2&user=u"), `jdbc:mysql://h/x?pass=${REDACTED}&user=u`);
  assert.equal(redactText("${DB_PASS:hunter2P}"), `\${DB_PASS:${REDACTED}}`);
  assert.equal(redactText("${X_PW:hunter2Q}"), `\${X_PW:${REDACTED}}`);
});

test("Basic and Bearer credentials are redacted under any key, but the plain word is left alone", () => {
  assert.equal(redactText("Authorization: Basic dXNlcjpwYXNz"), `Authorization: Basic ${REDACTED}`);
  assert.equal(redactText("Bearer abc.def-ghi"), `Bearer ${REDACTED}`);
  assert.equal(redactText("Token bucket configuration for Basic auth"), "Token bucket configuration for Basic auth");
});

test("redactRouteArgs hides the value after a secret-looking header or parameter name (shortcut and map forms)", () => {
  assert.deepEqual(redactRouteArgs(["Authorization", "Bearer hunter2W"]), ["Authorization", REDACTED]);
  assert.deepEqual(redactRouteArgs(["X-Api-Key", "hunter2X"]), ["X-Api-Key", REDACTED]);
  assert.deepEqual(redactRouteArgs(["name=X-Token", "value=hunter2Y"]), ["name=X-Token", `value=${REDACTED}`]);
  assert.deepEqual(redactRouteArgs(["X-Request-Id", "abc"]), ["X-Request-Id", "abc"]);
  assert.deepEqual(redactRouteArgs([]), []);
});

test("a long all-lowercase hyphenated service name is not mistaken for a key", () => {
  assert.equal(redactText("customer-order-management-service-v2"), "customer-order-management-service-v2");
  assert.equal(redactText("aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"), REDACTED);
});

test("stripControls removes terminal escapes and newlines from printed text", () => {
  assert.equal(stripControls("a\u001b[31mred\u001b[0m\nb\u0007"), "a [31mred [0m b ");
});
