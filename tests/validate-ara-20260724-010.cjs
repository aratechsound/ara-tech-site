const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const security = require("../api/_request-security.cjs");
const scheduleResponseApi = require("../api/pa-schedule-response.js");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const productionEnvironment = {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    ALLOWED_ORIGINS: "https://ara-tech.cc, https://partner.example:8443",
    SUPABASE_URL: "https://test-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role",
    RATE_LIMIT_HASH_SECRET: "test-only-rate-limit-hmac-secret"
};

const requestFor = (origin = "https://ara-tech.cc", address = "203.0.113.10") => ({
    method: "POST",
    headers: {
        ...(origin === null ? {} : { origin }),
        "x-forwarded-for": address
    },
    socket: { remoteAddress: address }
});

const makeResponse = () => ({
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
        return this.headers[String(name).toLowerCase()];
    },
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(payload) {
        this.payload = payload;
        return this;
    }
});

assert.deepEqual(
    security.parseAllowedOrigins(productionEnvironment),
    ["https://ara-tech.cc", "https://partner.example:8443"]
);
assert.equal(
    security.isOriginAllowed(requestFor("https://ara-tech.cc"), productionEnvironment),
    true
);
assert.equal(
    security.isOriginAllowed(requestFor("https://ARA-TECH.CC"), productionEnvironment),
    true
);
assert.equal(
    security.isOriginAllowed(requestFor("https://ara-tech.cc.evil.example"), productionEnvironment),
    false
);
assert.equal(
    security.isOriginAllowed(requestFor("https://evil.example/https://ara-tech.cc"), productionEnvironment),
    false
);
assert.equal(
    security.isOriginAllowed(requestFor("https://partner.example"), productionEnvironment),
    false
);
assert.equal(
    security.isOriginAllowed(requestFor(null), { NODE_ENV: "production" }),
    true
);
assert.equal(
    security.isOriginAllowed(requestFor("https://ara-tech.cc"), { NODE_ENV: "production" }),
    false
);
assert.throws(
    () => security.parseAllowedOrigins({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://ara-tech.cc/path"
    }),
    /invalid_origin/
);

const allowedOriginResponse = makeResponse();
assert.equal(
    security.applyOriginPolicy(
        requestFor("https://ara-tech.cc"),
        allowedOriginResponse,
        productionEnvironment
    ),
    true
);
assert.equal(
    allowedOriginResponse.headers["access-control-allow-origin"],
    "https://ara-tech.cc"
);
assert.equal(allowedOriginResponse.headers.vary, "Origin");

const deniedOriginResponse = makeResponse();
assert.equal(
    security.applyOriginPolicy(
        requestFor("https://attacker.example"),
        deniedOriginResponse,
        productionEnvironment
    ),
    false
);
assert.equal(deniedOriginResponse.headers["access-control-allow-origin"], undefined);

const noOriginResponse = makeResponse();
assert.equal(
    security.applyOriginPolicy(requestFor(null), noOriginResponse, productionEnvironment),
    true
);
assert.equal(noOriginResponse.headers["access-control-allow-origin"], undefined);

const apiFiles = [
    "api/pa-inquiry.js",
    "api/pa-mail.js",
    "api/pa-schedule-response.js",
    "api/pa-case-trash.js"
];
const apiSources = new Map(apiFiles.map((file) => [file, read(file)]));
for (const [file, source] of apiSources) {
    assert.match(source, /require\("\.\/_request-security\.cjs"\)/, `${file} must use the common module`);
    assert.match(source, /checkRateLimit\(/, `${file} must use shared RPC rate limiting`);
    assert.doesNotMatch(source, /new Map\(|rateWindows/, `${file} must not use process-only counters`);
    assert.doesNotMatch(source, /require\("\.\/_security\.cjs"\)/, `${file} must not reference the legacy module`);
    assert.doesNotMatch(source, /originUrl\.host|x-forwarded-host/, `${file} must not duplicate Origin rules`);
}
assert.match(apiSources.get("api/pa-inquiry.js"), /RATE_LIMIT_POLICY = "PUBLIC_INQUIRY"/);
assert.match(apiSources.get("api/pa-mail.js"), /send_schedule: "PA_MAIL_SEND_SCHEDULE"/);
assert.match(apiSources.get("api/pa-mail.js"), /send_result: "PA_MAIL_SEND_RESULT"/);
assert.match(apiSources.get("api/pa-mail.js"), /retry: "PA_MAIL_RETRY"/);
assert.match(apiSources.get("api/pa-schedule-response.js"), /RATE_LIMIT_POLICY = "SCHEDULE_RESPONSE"/);
assert.doesNotMatch(
    apiSources.get("api/pa-schedule-response.js"),
    /error_summary:\s*delivery\.error_summary\s*\|\|/,
    "public schedule responses must not expose provider error details"
);
assert.match(apiSources.get("api/pa-case-trash.js"), /purge: "CASE_TRASH_PURGE"/);

assert.equal(fs.existsSync(path.join(root, "api", "_security.cjs")), false);
assert.equal(
    fs.existsSync(path.join(root, "supabase", "migrations", "2026-07-24-pa-shared-rate-limit.sql")),
    false
);
assert.equal(
    fs.existsSync(path.join(root, "tests", "validate-ara-20260724-010-security.cjs")),
    false
);

const migration = read("supabase/migrations/2026-07-24-pa-api-security-hardening.sql");
assert.match(migration, /^begin;/mu);
assert.match(migration, /^commit;/mu);
assert.match(migration, /create table if not exists public\.api_rate_limit_buckets/u);
assert.match(migration, /create or replace function public\.consume_rate_limit\(/u);
assert.match(migration, /on conflict \(bucket_key\) do update/u);
assert.match(migration, /security definer/u);
assert.match(migration, /set search_path = pg_catalog, public/u);
assert.match(migration, /enable row level security/u);
assert.match(
    migration,
    /revoke all on table public\.api_rate_limit_buckets from public, anon, authenticated/u
);
assert.match(
    migration,
    /revoke all on function public\.consume_rate_limit\(text, integer, integer\)[\s\S]*?from public, anon, authenticated/u
);
assert.match(
    migration,
    /grant execute on function public\.consume_rate_limit\(text, integer, integer\)[\s\S]*?to service_role/u
);
assert.doesNotMatch(migration, /grant[\s\S]{0,120}consume_rate_limit[\s\S]{0,120}to (?:anon|authenticated)/iu);
assert.doesNotMatch(migration, /make_interval\s*\(\s*millis/iu);
assert.match(migration, /interval '1 millisecond'/u);

const workflow = read(".github/workflows/security-checks.yml");
assert.match(workflow, /node tests\/validate-ara-20260724-010\.cjs/u);
assert.match(workflow, /tests\/validate-ara-\*\.cjs/u);
assert.match(workflow, /node --check/u);
assert.match(workflow, /git diff --check/u);

const makeRateLimitFetch = ({ allowed = true, retryAfter = 0 } = {}) => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        const body = JSON.parse(String(options.body || "{}"));
        calls.push({ url: String(url), options, body });
        return {
            ok: true,
            status: 200,
            json: async () => [{
                allowed,
                remaining: allowed ? Math.max(0, body.p_limit - 1) : 0,
                retry_after_seconds: retryAfter,
                reset_at: "2026-07-28T12:10:00Z",
                limit: body.p_limit
            }]
        };
    };
    return { calls, fetchImpl };
};

const run = async () => {
    const { calls, fetchImpl } = makeRateLimitFetch();
    const commonRequest = requestFor("https://ara-tech.cc", "198.51.100.20");

    await security.checkRateLimit({
        request: commonRequest,
        policyName: "PUBLIC_INQUIRY",
        fetchImpl,
        environment: productionEnvironment,
        windowMs: 1,
        maxRequests: 999999
    });
    await security.checkRateLimit({
        request: commonRequest,
        policyName: "SCHEDULE_RESPONSE",
        fetchImpl,
        environment: productionEnvironment
    });
    await security.checkRateLimit({
        request: commonRequest,
        policyName: "PA_MAIL_SEND_SCHEDULE",
        scope: "00000000-0000-4000-8000-000000000999",
        fetchImpl,
        environment: productionEnvironment
    });

    assert.equal(calls.length, 3);
    assert.equal(calls[0].body.p_limit, security.RATE_LIMIT_POLICIES.PUBLIC_INQUIRY.maxRequests);
    assert.equal(calls[0].body.p_window_ms, security.RATE_LIMIT_POLICIES.PUBLIC_INQUIRY.windowMs);
    assert.notEqual(calls[0].body.p_bucket_key, calls[1].body.p_bucket_key);
    assert.notEqual(calls[0].body.p_bucket_key, calls[2].body.p_bucket_key);
    assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer test-only-service-role"));
    assert.ok(calls.every((call) => !JSON.stringify(call.body).includes("198.51.100.20")));
    assert.ok(calls.every((call) => !JSON.stringify(call.body).includes("test-only-service-role")));

    const bucketA = security.buildRateLimitBucket({
        request: commonRequest,
        policyName: "PUBLIC_INQUIRY",
        environment: productionEnvironment
    });
    const bucketB = security.buildRateLimitBucket({
        request: requestFor("https://ara-tech.cc", "198.51.100.20"),
        policyName: "PUBLIC_INQUIRY",
        environment: productionEnvironment
    });
    const bucketOtherClient = security.buildRateLimitBucket({
        request: requestFor("https://ara-tech.cc", "198.51.100.21"),
        policyName: "PUBLIC_INQUIRY",
        environment: productionEnvironment
    });
    assert.equal(bucketA, bucketB);
    assert.notEqual(bucketA, bucketOtherClient);
    assert.match(bucketA, /^pa-api:v1:pa-inquiry:[0-9a-f]{64}$/u);

    await assert.rejects(
        security.checkRateLimit({
            request: commonRequest,
            policyName: "CLIENT_SUPPLIED_BUCKET",
            fetchImpl,
            environment: productionEnvironment
        }),
        /unknown_rate_limit_policy/
    );

    const exceededMock = makeRateLimitFetch({ allowed: false, retryAfter: 37 });
    const exceeded = await security.checkRateLimit({
        request: commonRequest,
        policyName: "SCHEDULE_RESPONSE",
        fetchImpl: exceededMock.fetchImpl,
        environment: productionEnvironment
    });
    assert.equal(exceeded.allowed, false);
    assert.equal(exceeded.retryAfter, 37);

    const rpcFailure = await security.checkRateLimit({
        request: commonRequest,
        policyName: "PUBLIC_INQUIRY",
        fetchImpl: async () => ({
            ok: false,
            status: 503,
            json: async () => ({ internal: "test-only-service-role" })
        }),
        environment: productionEnvironment
    }).catch((error) => error);
    assert.equal(rpcFailure.message, "rate_limit_unavailable");
    assert.doesNotMatch(String(rpcFailure.stack), /test-only-service-role/u);

    const previousEnvironment = {
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
        NODE_ENV: process.env.NODE_ENV,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        RATE_LIMIT_HASH_SECRET: process.env.RATE_LIMIT_HASH_SECRET
    };
    const previousFetch = global.fetch;
    const previousConsoleError = console.error;
    process.env.ALLOWED_ORIGINS = "https://ara-tech.cc";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_URL = productionEnvironment.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = productionEnvironment.SUPABASE_SERVICE_ROLE_KEY;
    process.env.RATE_LIMIT_HASH_SECRET = productionEnvironment.RATE_LIMIT_HASH_SECRET;
    console.error = () => {};

    const invokeScheduleResponse = async (origin, fetchMock) => {
        global.fetch = fetchMock;
        const response = makeResponse();
        await scheduleResponseApi({
            ...requestFor(origin, "203.0.113.40"),
            body: {
                token: "sensitive-test-token",
                response: { decision: "agree" },
                submission_key: "00000000-0000-4000-8000-000000000101"
            }
        }, response);
        return response;
    };

    try {
        let fetchCount = 0;
        const invalidOrigin = await invokeScheduleResponse(
            "https://ara-tech.cc.attacker.example",
            async () => {
                fetchCount += 1;
                throw new Error("must not be called");
            }
        );
        assert.equal(invalidOrigin.statusCode, 403);
        assert.equal(invalidOrigin.payload.code, "invalid_origin");
        assert.equal(invalidOrigin.headers["access-control-allow-origin"], undefined);
        assert.equal(fetchCount, 0);

        const limitedFetch = makeRateLimitFetch({ allowed: false, retryAfter: 19 });
        const limited = await invokeScheduleResponse("https://ara-tech.cc", limitedFetch.fetchImpl);
        assert.equal(limited.statusCode, 429);
        assert.deepEqual(limited.payload, { ok: false, code: "rate_limited" });
        assert.equal(limited.headers["retry-after"], "19");
        assert.equal(limited.headers["access-control-allow-origin"], "https://ara-tech.cc");
        assert.doesNotMatch(JSON.stringify(limited.payload), /sensitive-test-token|test-only-service-role/u);

        const noOriginLimited = await invokeScheduleResponse(null, limitedFetch.fetchImpl);
        assert.equal(noOriginLimited.statusCode, 429);
        assert.equal(noOriginLimited.headers["access-control-allow-origin"], undefined);

        const unavailable = await invokeScheduleResponse(
            "https://ara-tech.cc",
            async () => ({
                ok: false,
                status: 500,
                json: async () => ({ internal: "database stack and secret" })
            })
        );
        assert.equal(unavailable.statusCode, 503);
        assert.deepEqual(unavailable.payload, { ok: false, code: "service_unavailable" });
        assert.doesNotMatch(JSON.stringify(unavailable.payload), /database|secret|stack/u);
    } finally {
        global.fetch = previousFetch;
        console.error = previousConsoleError;
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }

    console.log("ARA-20260724-010 shared rate limit and Origin security validation passed");
};

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
