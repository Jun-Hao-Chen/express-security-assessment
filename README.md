# Forum Security Review: Reproduce, Fix, Verify

A security review of a small Express.js discussion forum (about 1,000 lines, JSON-file storage) built for a Secure Coding course (final grade: 100/100).

Four defects were reproduced against the running application, fixed, and locked in with regression tests:

- **Before the fixes:** 7 of 8 security tests fail.
- **After the fixes:** 8 of 8 pass.

Raw test output is in [`evidence/`](evidence/).

| ID | Issue | Evidence before the fix | After the fix |
|---|---|---|---|
| F1 | Admin login fails open when `ADMIN_PASSWORD` is not set | `password=` (empty) returns "Admin login succeeded" | Login disabled (HTTP 503) until a password is configured; constant-time comparison |
| F2 | `/lab/status` reveals whether an admin password is set | Returns `adminPasswordConfigured: false`, signalling that F1 is exploitable | Field removed |
| F3 | Length limits enforced only on edit; create and reply rely on HTML `maxlength` | A 90,000-character post is accepted (HTTP 302) and stored; a missing field crashes the handler (HTTP 500) | One server-side validator for create, reply and edit (HTTP 400); 32 KB request-body cap (HTTP 413) |
| F4 | Unlocked read-modify-write on a JSON file, with non-atomic writes | 50 concurrent posts: 32 return 302 and 18 return 500 (`SyntaxError: Unexpected end of JSON input`); only 11 are stored | All 50 return 302, all 50 are stored, and every ID is unique |
| L1 | No authentication: anyone can edit or delete any post | By design (anonymous forum) | Not fixed; documented under Limitations |

## Context

For the course's static-analysis demo, five insecure patterns were planted in the code (a hardcoded password, a hardcoded API key, reflected input, `eval`, and MD5) and matched with exact-pattern Semgrep rules. That exercise demonstrates tool usage, not discovery: rules written to match planted lines find only those lines.

The findings below come from reviewing the forum code itself.

## Findings

### F1: Fail-open admin login

When the hardcoded demo password was removed, the replacement read the password from an environment variable with an empty-string fallback:

```js
const adminPassword = process.env.ADMIN_PASSWORD || "";
// ...
const message = password === adminPassword ? "Admin login succeeded." : "Admin login failed.";
```

With the variable unset, submitting an empty password compares `"" === ""` and succeeds. In other words, the fix for one vulnerability introduced another.

**Fix:**

- If no password is configured, the login is refused (fail closed).
- Passwords are compared with `crypto.timingSafeEqual` on SHA-256 digests. Hashing gives both inputs equal length, which `timingSafeEqual` requires.

### F2: Configuration disclosure

`/lab/status` returned `adminPasswordConfigured: false`, which told an attacker that F1 would work.

**Fix:** The field was removed.

### F3: Inconsistent server-side validation

The edit route enforced limits of 40 characters for the name and 2,000 for the message. The create and reply routes checked only that the fields were non-empty:

```js
const name = req.body.name.trim();     // TypeError if the field is missing -> HTTP 500
const text = req.body.message.trim();
if (!name || !text) { /* ... */ }      // no length check
```

The browser's `maxlength` attribute is a hint, not a control: any client can send a raw POST.

**Fix:**

- One `validatePostInput()` is shared by create, reply and edit. It returns 400 for missing or oversized fields.
- `express.urlencoded` caps the request body at 32 KB, and oversized bodies return 413.

### F4: Lost updates and torn reads

Every write route read the whole JSON array, changed it, and wrote it back, with no lock. Two concurrent requests could read the same array, and the later write silently discarded the earlier one.

`fs.writeFile` truncates the file before writing, so a request that read the file mid-write got a partial document. `JSON.parse` then threw, and the request failed with HTTP 500. IDs came from `Date.now()`, so two posts created in the same millisecond could share an ID.

**Fix:**

- **Serialized writes:** `withDataLock()` runs read-modify-write cycles one at a time.
- **Atomic writes:** each write goes to a temporary file in the same directory and is then renamed over the data file, so readers always see a complete file.
- **Unique IDs:** IDs come from `crypto.randomUUID()`.

Duplicate IDs were not observed during testing. The UUID change removes the possibility by design.

## Verification

The regression tests are in [`test/security.test.js`](test/security.test.js), and the full code change is in [`security-fixes.diff`](security-fixes.diff).

Each test starts a fresh copy of the application in a temporary directory with empty data, so test runs never touch real data.

```bash
APP_FILE=app.original.js node --test --test-reporter=tap test/security.test.js   # before
node --test --test-reporter=tap test/security.test.js                            # after
```

The full application source is kept private and is available on request.

## Limitations

- **L1, no authentication:** the forum is anonymous, so anyone can edit or delete any post, including all of its replies. A proper fix requires identity, for example a per-post secret token issued to the author or authenticated accounts. That is outside the scope of this review.
- **Single-process lock:** the lock in F4 works within one Node.js process. Running several processes would require a file lock or a database.
- **Not a complete audit:** this is not a penetration test or a full audit. Other issues may remain.
