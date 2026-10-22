const assert = require("node:assert/strict");
const test = require("node:test");
const {
    buildCallHistoryQuery,
    canViewCallHistory,
    finalizeCallRecord,
    finalizeUnansweredCall,
    resolveCallFinalFields
} = require("./callHistoryUtils");

test("call history query and access checks are limited to the two participants", () => {
    const query = buildCallHistoryQuery("a", "b");
    assert.deepEqual(query, {
        $or: [
            { callerId: "a", calleeId: "b" },
            { callerId: "b", calleeId: "a" }
        ]
    });

    const call = { callerId: "a", calleeId: "b" };
    assert.equal(canViewCallHistory(call, "a", "b"), true);
    assert.equal(canViewCallHistory(call, "b", "a"), true);
    assert.equal(canViewCallHistory(call, "a", "c"), false);
    assert.equal(canViewCallHistory(call, "c", "b"), false);
});

test("call outcomes and duration use actual connection and end times", () => {
    const call = { callerId: "a", calleeId: "b", connectedAt: new Date(1000) };
    assert.deepEqual(resolveCallFinalFields(call, "end", "a", new Date(12599)), {
        status: "completed",
        endedAt: new Date(12599),
        durationSeconds: 11
    });
    assert.equal(resolveCallFinalFields({ ...call, connectedAt: null }, "rejected", "b").status, "rejected");
    assert.equal(resolveCallFinalFields({ ...call, connectedAt: null }, "missed", "b").status, "missed");
    assert.equal(resolveCallFinalFields({ ...call, connectedAt: null }, "end", "a").status, "cancelled");
    assert.equal(resolveCallFinalFields({ ...call, connectedAt: null }, "disconnect", "b").status, "missed");
    assert.equal(resolveCallFinalFields({ ...call, connectedAt: null }, "disconnect", "a").status, "cancelled");
});

test("only one concurrent finalization changes a pending call", async () => {
    const record = { _id: "record-1", callId: "call-1", callerId: "a", calleeId: "b", status: "pending", connectedAt: null };
    const model = {
        async findOne(filter) {
            return record.status === filter.status ? { ...record } : null;
        },
        async findOneAndUpdate(filter, update) {
            if (record._id !== filter._id || record.status !== filter.status || record.connectedAt !== filter.connectedAt) return null;
            Object.assign(record, update.$set);
            return { ...record };
        }
    };

    const results = await Promise.all([
        finalizeCallRecord(model, "call-1", "rejected", "b", new Date(2000)),
        finalizeCallRecord(model, "call-1", "missed", "b", new Date(3000))
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(record.status, "rejected");
});

test("unanswered timeout marks only pending calls with no connection as missed", async () => {
    const records = [
        { callId: "ringing", status: "pending", connectedAt: null },
        { callId: "connected", status: "pending", connectedAt: new Date(500) }
    ];
    const CallHistory = {
        async findOneAndUpdate(filter, update) {
            const record = records.find((item) => item.callId === filter.callId && item.status === filter.status && item.connectedAt === filter.connectedAt);
            if (!record) return null;
            Object.assign(record, update.$set);
            return { ...record };
        }
    };
    const endedAt = new Date(10_000);
    const timedOut = await finalizeUnansweredCall(CallHistory, "ringing", endedAt);
    assert.equal(timedOut.status, "missed");
    assert.equal(timedOut.durationSeconds, 0);
    assert.equal(timedOut.endedAt, endedAt);
    assert.equal(await finalizeUnansweredCall(CallHistory, "ringing", endedAt), null);
    assert.equal(await finalizeUnansweredCall(CallHistory, "connected", endedAt), null);
});
