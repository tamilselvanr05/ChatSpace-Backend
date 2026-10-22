const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
    MAX_INPUT_CHARACTERS,
    MAX_PASTED_TEXT_CHARACTERS,
    GEMINI_REQUEST_TIMEOUT_MS,
    SUMMARY_TYPES,
    buildProviderPrompt,
    buildSummaryTranscript,
    createAuthorizedMessageLoader,
    createChatSummaryRouter,
    createUserRateLimiter,
    classifyProviderError,
    validateSummaryRequest
} = require("./chatSummarization");
const { buildPrivateConversationQuery } = require("./selfConversation");

const validBody = { source: "chat", conversationType: "private", conversationId: "peer-1", summaryType: "full" };
const isValidId = (id) => /^[a-z0-9-]{1,30}$/i.test(id);

async function withSummaryServer({ authMiddleware, findAuthorizedMessages, generateSummary, limiter, logger = { error() {} } }, callback) {
    const app = express();
    app.use(express.json());
    app.use("/ai", createChatSummaryRouter({ authMiddleware, isValidId, findAuthorizedMessages, generateSummary, limiter, logger }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        return await callback(`http://127.0.0.1:${server.address().port}/ai/summarize`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

const testAuth = (req, res, next) => {
    if (req.headers.authorization !== "Bearer valid-test-token") return res.status(401).json({ message: "Unauthorized" });
    req.user = { userId: req.headers["x-user-id"] || "owner-1" };
    return next();
};
const fakeMessages = [{ messageType: "text", senderName: "Sam", message: "We will ship Friday." }];

test("summary route requires authentication before database or provider work", async () => {
    let dbCalls = 0;
    let providerCalls = 0;
    await withSummaryServer({
        authMiddleware: testAuth,
        findAuthorizedMessages: async () => { dbCalls += 1; return fakeMessages; },
        generateSummary: async () => { providerCalls += 1; return "summary"; }
    }, async (url) => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validBody) });
        assert.equal(response.status, 401);
    });
    assert.equal(dbCalls, 0);
    assert.equal(providerCalls, 0);
});

test("summary route validates the target before rate limiting or database access", async () => {
    let dbCalls = 0;
    const limiter = () => { throw new Error("Invalid requests must not consume rate limit"); };
    await withSummaryServer({ authMiddleware: testAuth, limiter, findAuthorizedMessages: async () => { dbCalls += 1; return fakeMessages; }, generateSummary: async () => "summary" }, async (url) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" },
            body: JSON.stringify({ conversationType: "group", conversationId: "bad id" })
        });
        assert.equal(response.status, 400);
    });
    assert.equal(dbCalls, 0);
    assert.equal(validateSummaryRequest(validBody, isValidId).conversationId, "peer-1");
});

test("request validation accepts pasted text without chat identifiers and enforces its size and summary type", () => {
    assert.deepEqual(validateSummaryRequest({ source: "text", text: " Pasted note ", summaryType: "actions" }, isValidId), {
        source: "text", summaryType: "actions", text: "Pasted note"
    });
    assert.match(validateSummaryRequest({ source: "text", text: "x".repeat(MAX_PASTED_TEXT_CHARACTERS + 1), summaryType: "full" }, isValidId).error, /characters/);
    assert.ok(validateSummaryRequest({ source: "text", text: "text", summaryType: "made-up" }, isValidId).error);
    assert.ok(validateSummaryRequest({ source: "text", text: "  ", summaryType: "full" }, isValidId).error);
});

test("each summary type has distinct, non-inferential provider instructions", () => {
    assert.deepEqual(SUMMARY_TYPES, ["full", "actions", "decisions", "deadlines"]);
    const expected = {
        full: [/Key Points/, /Decisions/, /Action Items/, /Deadlines/],
        actions: [/only a ## Action Items/, /Do not infer or invent tasks/],
        decisions: [/only a ## Decisions/, /unresolved discussion/],
        deadlines: [/only a ## Deadlines/, /Do not calculate or infer missing dates/]
    };
    for (const summaryType of SUMMARY_TYPES) {
        const prompt = buildProviderPrompt({ source: "text", summaryType, transcript: "Untrusted text", messageCount: 0 });
        for (const instruction of expected[summaryType]) assert.match(prompt, instruction);
        assert.match(prompt, /untrusted quoted data/);
    }
});

test("Gemini timeout is bounded and provider failures distinguish model, access, quota, network, and deadline errors", () => {
    assert.equal(GEMINI_REQUEST_TIMEOUT_MS, 60_000);
    assert.equal(classifyProviderError({ name: "RequestTimeoutError" }).kind, "timeout");
    assert.equal(classifyProviderError({ name: "APIConnectionTimeoutError" }).kind, "timeout");
    assert.equal(classifyProviderError({ name: "APIConnectionError" }).kind, "provider_unavailable");
    assert.equal(classifyProviderError({ status: 404, code: "NOT_FOUND" }).kind, "model_unavailable");
    assert.equal(classifyProviderError({ status: 403, code: "PERMISSION_DENIED" }).kind, "provider_access");
    assert.equal(classifyProviderError({ status: 429, code: "RESOURCE_EXHAUSTED" }).kind, "quota_or_busy");
    assert.equal(classifyProviderError({ cause: { code: "ECONNRESET" } }).kind, "provider_unavailable");
    assert.equal(classifyProviderError({ status: 504, code: "DEADLINE_EXCEEDED" }).status, 504);
});

test("pasted-text mode skips conversation membership lookup", async () => {
    let authorizedChatLookup = false;
    let supplied;
    await withSummaryServer({
        authMiddleware: testAuth,
        findAuthorizedMessages: async () => { authorizedChatLookup = true; throw new Error("membership lookup should not happen for user text"); },
        generateSummary: async (request) => { supplied = request; return "## Action Items\\n- Ask Pat"; }
    }, async (url) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" },
            body: JSON.stringify({ source: "text", text: "Ask Pat to review the PR", summaryType: "actions" })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.source, "text");
        assert.equal(body.characterCount, "Ask Pat to review the PR".length);
        assert.equal(body.messageCount, undefined);
    });
    assert.equal(authorizedChatLookup, false);
    assert.deepEqual(supplied, { transcript: "Ask Pat to review the PR", messageCount: 0, source: "text", summaryType: "actions" });
});

test("pasted-text requests use the authenticated user's rate limit and sanitize provider failures", async () => {
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });
    let providerCalls = 0;
    await withSummaryServer({
        authMiddleware: testAuth,
        limiter,
        findAuthorizedMessages: async () => { throw new Error("pasted text must not require chat membership"); },
        generateSummary: async () => {
            providerCalls += 1;
            throw new Error("private provider payload");
        }
    }, async (url) => {
        const send = (user) => fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json", "x-user-id": user },
            body: JSON.stringify({ source: "text", summaryType: "full", text: "Pasted source" })
        });
        const first = await send("owner-1");
        assert.equal(first.status, 502);
        assert.doesNotMatch(await first.text(), /private provider payload/);
        assert.equal((await send("owner-1")).status, 429);
        assert.equal((await send("owner-2")).status, 502);
    });
    assert.equal(providerCalls, 2);
});

test("provider diagnostics are useful but never log pasted content, provider messages, or credentials", async () => {
    const logEntries = [];
    await withSummaryServer({
        authMiddleware: testAuth,
        logger: { error: (...entry) => logEntries.push(entry) },
        findAuthorizedMessages: async () => { throw new Error("chat lookup is not expected"); },
        generateSummary: async () => {
            const error = new Error("sensitive prompt and API key=secret-value");
            error.status = 404;
            error.code = "NOT_FOUND";
            throw error;
        }
    }, async (url) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" },
            body: JSON.stringify({ source: "text", summaryType: "full", text: "private-pasted-content" })
        });
        assert.equal(response.status, 503);
        assert.match((await response.json()).message, /GEMINI_MODEL/);
    });
    const serialized = JSON.stringify(logEntries);
    assert.match(serialized, /model_unavailable/);
    assert.match(serialized, /NOT_FOUND/);
    assert.doesNotMatch(serialized, /private-pasted-content|sensitive prompt|secret-value/);
});

test("unauthorized conversation never reaches provider", async () => {
    let providerCalls = 0;
    await withSummaryServer({ authMiddleware: testAuth, findAuthorizedMessages: async () => null, generateSummary: async () => { providerCalls += 1; return "summary"; } }, async (url) => {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify({ conversationType: "group", conversationId: "group-4" }) });
        assert.equal(response.status, 404);
    });
    assert.equal(providerCalls, 0);
});

test("per-user rate limit blocks a provider call and is isolated by user", async () => {
    const limiter = createUserRateLimiter({ limit: 1, windowMs: 60_000 });
    let providerCalls = 0;
    await withSummaryServer({ authMiddleware: testAuth, limiter, findAuthorizedMessages: async () => fakeMessages, generateSummary: async () => { providerCalls += 1; return "summary"; } }, async (url) => {
        const send = (user) => fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json", "x-user-id": user },
            body: JSON.stringify(validBody)
        });
        assert.equal((await send("owner-1")).status, 200);
        assert.equal((await send("owner-1")).status, 429);
        assert.equal((await send("owner-2")).status, 200);
    });
    assert.equal(providerCalls, 2);
});

test("authorized message loader enforces group membership and private participants", async () => {
    let messageQuery;
    let groupQuery;
    let userQuery;
    let messageSort;
    let groupAllowed = false;
    const query = (result) => ({ select() { return this; }, sort(value) { messageSort = value; return this; }, limit() { return this; }, async lean() { return result; } });
    const loader = createAuthorizedMessageLoader({
        isValidId,
        buildPrivateConversationQuery,
        User: { findOne(filter) { userQuery = filter; return query({ _id: "peer-1" }); } },
        Group: { findOne(filter) { groupQuery = filter; return query(groupAllowed ? { _id: "group-1" } : null); } },
        Message: { find(filter) { messageQuery = filter; return query(fakeMessages); } }
    });

    assert.equal(await loader("owner-1", { conversationType: "group", conversationId: "group-1" }), null);
    assert.deepEqual(groupQuery, { _id: "group-1", members: "owner-1" });
    groupAllowed = true;
    await loader("owner-1", { conversationType: "group", conversationId: "group-1" });
    assert.deepEqual(messageQuery.deletedFor, { $ne: "owner-1" });
    assert.equal(messageQuery.messageType, "text");
    assert.deepEqual(messageSort, { createdAt: -1 });

    await loader("owner-1", validBody);
    assert.deepEqual(userQuery, { _id: "peer-1", isDeleted: { $ne: true } });
    assert.deepEqual(messageQuery.$or, [
        { senderId: "owner-1", receiverId: "peer-1" },
        { senderId: "peer-1", receiverId: "owner-1" }
    ]);
    assert.equal(messageQuery.groupId, null);
    assert.deepEqual(messageSort, { createdAt: -1 });
});

test("only bounded text messages are included in the provider transcript", () => {
    const input = [
        { messageType: "text", senderName: "B", message: "Second", createdAt: "2025-01-01T00:00:00Z" },
        { messageType: "audio", message: "voice content" },
        { messageType: "text", senderName: "A", message: "First" },
        { messageType: "image", message: "image caption", fileUrl: "secret/path" },
    ];
    const built = buildSummaryTranscript(input);
    assert.equal(built.messageCount, 2);
    assert.match(built.transcript, /A: First/);
    assert.match(built.transcript, /B: Second/);
    assert.doesNotMatch(built.transcript, /secret\/path|image caption|voice content/);
    assert.ok(buildSummaryTranscript([{ messageType: "text", message: "x".repeat(MAX_INPUT_CHARACTERS + 500) }]).transcript.length <= MAX_INPUT_CHARACTERS);
});

test("quota and provider errors are sanitized; success is returned without persisting", async () => {
    await withSummaryServer({
        authMiddleware: testAuth,
        findAuthorizedMessages: async () => fakeMessages,
        generateSummary: async () => { const error = new Error("private provider payload"); error.status = 429; throw error; }
    }, async (url) => {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(validBody) });
        assert.equal(response.status, 429);
        assert.match((await response.text()), /free-tier quota/);
    });

    await withSummaryServer({
        authMiddleware: testAuth,
        findAuthorizedMessages: async () => fakeMessages,
        generateSummary: async () => { throw new Error("private provider payload"); }
    }, async (url) => {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(validBody) });
        assert.equal(response.status, 502);
        assert.doesNotMatch(await response.text(), /private provider payload/);
    });
});

test("summarized text is returned with the covered message count, and provider configuration and timeout errors are handled", async () => {
    await withSummaryServer({
        authMiddleware: testAuth,
        findAuthorizedMessages: async () => fakeMessages,
        generateSummary: async ({ transcript, messageCount }) => {
            assert.match(transcript, /We will ship Friday/);
            assert.equal(messageCount, 1);
            return "## Key Points\n- Ship Friday\n## Decisions\nNone identified.\n## Action Items\nNone identified.\n## Deadlines\nFriday";
        }
    }, async (url) => {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(validBody) });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.messageCount, 1);
        assert.match(body.summary, /Ship Friday/);
    });

    for (const [failure, expectedStatus, expectedText] of [
        [{ code: "GEMINI_NOT_CONFIGURED" }, 503, /not configured/],
        [{ name: "TimeoutError" }, 504, /60 seconds/]
    ]) {
        await withSummaryServer({
            authMiddleware: testAuth,
            findAuthorizedMessages: async () => fakeMessages,
            generateSummary: async () => { throw failure; }
        }, async (url) => {
            const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(validBody) });
            assert.equal(response.status, expectedStatus);
            assert.match(await response.text(), expectedText);
        });
    }
});
