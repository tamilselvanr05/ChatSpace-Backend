function idString(value) {
    return value?._id?.toString?.() || value?.toString?.() || "";
}

function buildCallHistoryQuery(userId, otherUserId) {
    return {
        $or: [
            { callerId: userId, calleeId: otherUserId },
            { callerId: otherUserId, calleeId: userId }
        ]
    };
}

function canViewCallHistory(call, userId, otherUserId) {
    const callerId = idString(call.callerId);
    const calleeId = idString(call.calleeId);
    const current = idString(userId);
    const other = idString(otherUserId);
    return Boolean(current && other && current !== other &&
        ((callerId === current && calleeId === other) ||
            (callerId === other && calleeId === current)));
}

function resolveCallFinalFields(call, reason, actorId, endedAt = new Date()) {
    const connectedAt = call.connectedAt ? new Date(call.connectedAt) : null;
    let status;

    if (connectedAt && !Number.isNaN(connectedAt.getTime())) {
        status = "completed";
    } else if (reason === "disconnect") {
        status = idString(actorId) === idString(call.callerId) ? "cancelled" : "missed";
    } else if (reason === "end") {
        status = idString(actorId) === idString(call.callerId) ? "cancelled" : "rejected";
    } else {
        status = reason;
    }

    const endTime = new Date(endedAt);
    const durationSeconds = status === "completed"
        ? Math.max(0, Math.floor((endTime.getTime() - connectedAt.getTime()) / 1000))
        : 0;

    return { status, endedAt: endTime, durationSeconds };
}

async function finalizeCallRecord(CallHistory, callId, reason, actorId, endedAt = new Date()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const call = await CallHistory.findOne({ callId, status: "pending" });
        if (!call) return null;

        const finalFields = resolveCallFinalFields(call, reason, actorId, endedAt);
        const updated = await CallHistory.findOneAndUpdate(
            {
                _id: call._id,
                status: "pending",
                connectedAt: call.connectedAt || null
            },
            { $set: finalFields },
            { new: true }
        );
        if (updated) return updated;
    }

    return null;
}

async function finalizeUnansweredCall(CallHistory, callId, endedAt = new Date()) {
    return CallHistory.findOneAndUpdate(
        { callId, status: "pending", connectedAt: null },
        { $set: { status: "missed", endedAt, durationSeconds: 0 } },
        { new: true }
    );
}

module.exports = {
    buildCallHistoryQuery,
    canViewCallHistory,
    finalizeCallRecord,
    finalizeUnansweredCall,
    resolveCallFinalFields
};
