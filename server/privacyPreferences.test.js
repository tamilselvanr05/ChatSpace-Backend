const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createPrivacyPreferencesRouter, sanitizeGroupPresence, sanitizePresence, typingMayBeBroadcast } = require("./privacyPreferences");

const currentUserId = "user-a";
const otherUserId = "user-b";

function testAuth(req, res, next) {
    if (req.headers.authorization !== "Bearer user-a") return res.status(401).json({ message: "Unauthorized" });
    req.user = { userId: currentUserId };
    return next();
}

async function withPreferenceServer({ user, sockets = [], group = null }, callback) {
    const emitted = [];
    const io = {
        emit: (...args) => emitted.push(["broadcast", ...args]),
        in: (room) => ({ fetchSockets: async () => room === currentUserId ? sockets : [] }),
        to: (room) => ({ emit: (...args) => emitted.push([room, ...args]) })
    };
    const User = {
        findById: (id) => ({
            select: () => ({ lean: async () => id === currentUserId ? { ...user } : null })
        }),
        findByIdAndUpdate: (id, update) => ({
            lean: async () => {
                if (id !== currentUserId) return null;
                Object.assign(user, update.$set);
                return { ...user };
            }
        })
    };
    const Group = {
        findOne: (filter) => ({
            select: () => ({ lean: async () => group && group._id === filter._id && group.members.includes(filter.members) ? group : null })
        })
    };
    const app = express();
    app.use(express.json());
    app.use("/preferences/privacy", createPrivacyPreferencesRouter({
        authMiddleware: testAuth,
        User,
        Group,
        io,
        areUsersBlocked: async () => false,
        logger: { error() {} }
    }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        await callback(`http://127.0.0.1:${server.address().port}/preferences/privacy`, { emitted, user });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test("privacy settings load from the authenticated user's stored preferences", async () => {
    await withPreferenceServer({ user: { showOnlineStatus: false, readReceiptsEnabled: true, typingIndicatorEnabled: false } }, async (url) => {
        const unauthorized = await fetch(url);
        assert.equal(unauthorized.status, 401);
        const response = await fetch(url, { headers: { authorization: "Bearer user-a" } });
        assert.deepEqual(await response.json(), {
            showOnlineStatus: false,
            readReceiptsEnabled: true,
            typingIndicatorEnabled: false
        });
    });
});

test("typing preference is enforced by the server broadcast gate", () => {
    assert.equal(typingMayBeBroadcast(true), true);
    assert.equal(typingMayBeBroadcast(false), false);
    assert.equal(typingMayBeBroadcast(undefined), true);
});

test("each privacy preference saves only for the authenticated user and validates booleans", async () => {
    await withPreferenceServer({ user: { isOnline: true } }, async (url, { emitted, user }) => {
        const unauthorized = await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ preference: "showOnlineStatus", enabled: false })
        });
        assert.equal(unauthorized.status, 401);
        assert.equal(user.showOnlineStatus, undefined);

        for (const preference of ["showOnlineStatus", "readReceiptsEnabled", "typingIndicatorEnabled"]) {
            const response = await fetch(url, {
                method: "PATCH",
                headers: { authorization: "Bearer user-a", "content-type": "application/json" },
                body: JSON.stringify({ preference, enabled: false, userId: otherUserId })
            });
            assert.equal(response.status, 200);
            assert.equal(user[preference], false);
        }
        const invalid = await fetch(url, {
            method: "PATCH",
            headers: { authorization: "Bearer user-a", "content-type": "application/json" },
            body: JSON.stringify({ preference: "isOnline", enabled: false })
        });
        assert.equal(invalid.status, 400);
        const persisted = await fetch(url, { headers: { authorization: "Bearer user-a" } });
        assert.deepEqual(await persisted.json(), {
            showOnlineStatus: false,
            readReceiptsEnabled: false,
            typingIndicatorEnabled: false
        });
        assert.equal(emitted.some(([room, event, payload]) => room === "broadcast" && event === "userStatusChanged" && payload.isOnline === false), true);
        assert.equal(emitted.some(([room, event, payload]) => room === otherUserId && event === "userTyping" && payload.isTyping === false), false);

        await fetch(url, {
            method: "PATCH",
            headers: { authorization: "Bearer user-a", "content-type": "application/json" },
            body: JSON.stringify({ preference: "showOnlineStatus", enabled: true })
        });
        assert.equal(emitted.some(([room, event, payload]) => room === "broadcast" && event === "userStatusChanged" && payload.isOnline === true), true);
    });
});

test("turning typing off clears active private and group indicators for all user sockets", async () => {
    const privateSocket = { data: { activeTypingConversations: new Map([["private:user-b", { receiverId: otherUserId }]]) } };
    const groupSocket = { data: { activeTypingConversations: new Map([["group:group-1", { groupId: "group-1", username: "Alice" }]]) } };
    const group = { _id: "group-1", members: [currentUserId, otherUserId] };
    await withPreferenceServer({ user: {}, sockets: [privateSocket, groupSocket], group }, async (url, { emitted }) => {
        const response = await fetch(url, {
            method: "PATCH",
            headers: { authorization: "Bearer user-a", "content-type": "application/json" },
            body: JSON.stringify({ preference: "typingIndicatorEnabled", enabled: false })
        });
        assert.equal(response.status, 200);
        assert.equal(privateSocket.data.activeTypingConversations.size, 0);
        assert.equal(groupSocket.data.activeTypingConversations.size, 0);
        assert.equal(emitted.some(([room, event, payload]) => room === otherUserId && event === "userTyping" && payload.isTyping === false), true);
        assert.equal(emitted.filter(([room, event, payload]) => room === otherUserId && event === "userTyping" && payload.isTyping === false).length, 2);
    });
});

test("presence sanitization hides other users but keeps the viewer's own live state", () => {
    const hiddenUser = { _id: otherUserId, username: "Hidden", isOnline: true, showOnlineStatus: false };
    assert.equal(sanitizePresence(hiddenUser, currentUserId).isOnline, false);
    assert.equal(sanitizePresence(hiddenUser, otherUserId).isOnline, true);
    assert.equal("showOnlineStatus" in sanitizePresence(hiddenUser, currentUserId), false);
    const group = sanitizeGroupPresence({ _id: "group-1", members: [hiddenUser] }, currentUserId);
    assert.equal(group.members[0].isOnline, false);
});
