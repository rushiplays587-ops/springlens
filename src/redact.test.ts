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
