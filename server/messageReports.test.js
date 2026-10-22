const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createMessageReportRouter, createReportRateLimiter } = require("./messageReports");

const idIsValid = (value) => /^[a-z0-9-]{1,30}$/i.test(value);
const testAuth = (req, res, next) => {
    if (req.headers.authorization !== "Bearer valid-test-token") return res.status(401).json({ message: "Unauthorized" });
    req.user = { userId: req.headers["x-user-id"] || "reporter-1" };
    return next();
};

async function withReportServer({ Message, Group, MessageReport, consumeLimit, authMiddleware = testAuth }, callback) {
    const app = express();
    app.use(express.json());
    app.use("/messages", createMessageReportRouter({
        authMiddleware,
        isValidId: idIsValid,
        Message,
        Group,
        MessageReport,
        consumeLimit,
        logger: { error() {} }
    }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        return await callback(`http://127.0.0.1:${server.address().port}/messages`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

function messageQuery(message) {
    return { select() { return this; }, async lean() { return message; } };
}

test("message reports require authentication and reject invalid IDs before database access", async () => {
    let lookups = 0;
    const models = {
        Message: { findOne() { lookups += 1; return messageQuery(null); } },
        Group: { exists: async () => false },
        MessageReport: { exists: async () => false, create: async () => {} }
    };
    await withReportServer(models, async (url) => {
        const unauthorized = await fetch(`${url}/message-1/report`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "other" })
        });
        assert.equal(unauthorized.status, 401);
        const invalid = await fetch(`${url}/invalid id/report`, {
            method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify({ reason: "other" })
        });
        assert.equal(invalid.status, 400);
        assert.equal(lookups, 0);
    });
});

test("private participants can report; duplicate submissions are rejected and messages stay unchanged", async () => {
    const savedReports = [];
    let queryFilter;
    const models = {
        Message: { findOne(filter) { queryFilter = filter; return messageQuery({ _id: "message-1", senderId: "sender-1", receiverId: "reporter-1", groupId: null }); } },
        Group: { exists: async () => false },
        MessageReport: {
            exists: async (filter) => savedReports.some((report) => report.reporterId === filter.reporterId && report.messageId === filter.messageId),
            create: async (report) => { savedReports.push(report); }
        }
    };
    await withReportServer(models, async (url) => {
        const send = () => fetch(`${url}/message-1/report`, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" },
            body: JSON.stringify({ reason: "sensitive_information", details: "Please review the request." })
        });
        assert.equal((await send()).status, 201);
        const duplicate = await send();
        assert.equal(duplicate.status, 409);
        assert.deepEqual(queryFilter, { _id: "message-1", deletedFor: { $ne: "reporter-1" } });
        assert.deepEqual(savedReports, [{ reporterId: "reporter-1", messageId: "message-1", reason: "sensitive_information", details: "Please review the request." }]);
    });
});

test("group reports require current membership; unrelated private and group messages remain private", async () => {
    let groupMember = false;
    let privateMessage = { _id: "private-1", senderId: "someone-else", receiverId: "another-user", groupId: null };
    let groupMessage = { _id: "group-msg-1", senderId: "someone-else", receiverId: null, groupId: "group-1" };
    let currentMessage = privateMessage;
    const savedReports = [];
    let groupFilter;
    const models = {
        Message: { findOne() { return messageQuery(currentMessage); } },
        Group: { exists: async (filter) => { groupFilter = filter; return groupMember && filter.members === "reporter-1"; } },
        MessageReport: { exists: async () => false, create: async (report) => { savedReports.push(report); } }
    };
    await withReportServer(models, async (url) => {
        const send = () => fetch(`${url}/message-id/report`, {
            method: "POST",
            headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" },
            body: JSON.stringify({ reason: "impersonation" })
        });
        assert.equal((await send()).status, 404);
        currentMessage = groupMessage;
        assert.equal((await send()).status, 404);
        groupMember = true;
        currentMessage = { ...groupMessage, groupId: "group-id" };
        const group = await send();
        assert.equal(group.status, 201);
        assert.deepEqual(groupFilter, { _id: "group-id", members: "reporter-1" });
        assert.equal(savedReports.length, 1);
        assert.equal(savedReports[0].reporterId, "reporter-1");
    });
});

test("report reasons and details are validated and report throttling remains per user", async () => {
    let dbCalls = 0;
    let now = 0;
    const limiter = createReportRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    const models = {
        Message: { findOne() { dbCalls += 1; return messageQuery({ _id: "message-1", senderId: "sender-1", receiverId: "reporter-1", groupId: null }); } },
        Group: { exists: async () => false },
        MessageReport: { exists: async () => false, create: async () => {} }
    };
    await withReportServer({ ...models, consumeLimit: limiter }, async (url) => {
        const send = (payload) => fetch(`${url}/message-1/report`, {
            method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(payload)
        });
        assert.equal((await send({ reason: "fraudulent" })).status, 400);
        assert.equal((await send({ reason: "other", details: "x".repeat(501) })).status, 400);
        assert.equal((await send({ reason: "suspicious_link" })).status, 201);
        assert.equal((await send({ reason: "other" })).status, 429);
        now = 1_001;
        assert.equal((await send({ reason: "other" })).status, 201);
    });
    assert.equal(dbCalls, 3);
});
