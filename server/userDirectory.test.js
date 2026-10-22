const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { buildUserDirectoryQuery, createUserDirectoryRouter } = require("./userDirectory");

const ownerId = "64b000000000000000000001";
const peerId = "64b000000000000000000002";

function authMiddleware(req, res, next) {
    if (req.headers.authorization !== "Bearer owner") return res.status(401).json({ message: "Unauthorized" });
    req.user = { userId: ownerId };
    return next();
}

async function withDirectoryServer(callback) {
    const hiddenConversationIds = [peerId];
    const queriedUsers = [];
    const updates = [];
    const emitted = [];
    const users = [
        { _id: peerId, username: "Ramesh", isOnline: false },
        { _id: ownerId, username: "Owner", isOnline: true }
    ];
    const User = {
        findById: (id) => ({
            select: () => ({ lean: async () => id === ownerId ? { hiddenConversations: [...hiddenConversationIds] } : null })
        }),
        find: (query) => ({
            select: () => ({
                lean: async () => {
                    queriedUsers.push(query);
                    return users.filter((user) => user._id !== query._id.$ne &&
                        (!query._id.$nin || !query._id.$nin.includes(user._id)) &&
                        (!query.username || new RegExp(query.username.$regex, query.username.$options).test(user.username)));
                }
            })
        }),
        exists: async (query) => query._id === peerId ? { _id: peerId } : null,
        updateOne: async (...args) => {
            updates.push(args);
            hiddenConversationIds.splice(hiddenConversationIds.indexOf(peerId), 1);
        }
    };
    const io = { to: (room) => ({ emit: (...args) => emitted.push([room, ...args]) }) };
    const app = express();
    app.use("/users", createUserDirectoryRouter({
        authMiddleware,
        User,
        io,
        isValidId: (id) => /^[a-f\d]{24}$/i.test(id),
        sanitizePresence: (user) => user,
        logger: { error() {} }
    }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        await callback(`http://127.0.0.1:${server.address().port}/users`, {
            hiddenConversationIds, queriedUsers, updates, emitted
        });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test("ordinary directory omits removed contacts while a username search can find them", async () => {
    assert.deepEqual(buildUserDirectoryQuery(ownerId, [peerId]), {
        _id: { $ne: ownerId, $nin: [peerId] },
        isDeleted: { $ne: true }
    });
    const searchQuery = buildUserDirectoryQuery(ownerId, [peerId], "Ramesh");
    assert.deepEqual(searchQuery, {
        _id: { $ne: ownerId },
        isDeleted: { $ne: true },
        username: { $regex: "Ramesh", $options: "i" }
    });
    assert.equal(buildUserDirectoryQuery(ownerId, [], "a.b").username.$regex, "a\\.b");

    await withDirectoryServer(async (url, { queriedUsers }) => {
        const unauthorized = await fetch(url);
        assert.equal(unauthorized.status, 401);
        const normal = await fetch(url, { headers: { authorization: "Bearer owner" } });
        assert.deepEqual((await normal.json()).users.map((user) => user._id), []);
        const search = await fetch(`${url}?search=Ramesh`, { headers: { authorization: "Bearer owner" } });
        assert.deepEqual((await search.json()).users.map((user) => user._id), [peerId]);
        assert.deepEqual(queriedUsers[0]._id.$nin, [peerId]);
        assert.equal(queriedUsers[1]._id.$ne, ownerId);
    });
});

test("selecting a searched contact restores only the authenticated user's list entry", async () => {
    await withDirectoryServer(async (url, { hiddenConversationIds, updates, emitted }) => {
        const unauthorized = await fetch(`${url}/${peerId}/restore`, { method: "POST" });
        assert.equal(unauthorized.status, 401);
        const invalid = await fetch(`${url}/not-an-id/restore`, {
            method: "POST",
            headers: { authorization: "Bearer owner" }
        });
        assert.equal(invalid.status, 400);
        const response = await fetch(`${url}/${peerId}/restore`, {
            method: "POST",
            headers: { authorization: "Bearer owner" }
        });
        assert.equal(response.status, 200);
        assert.deepEqual(hiddenConversationIds, []);
        assert.deepEqual(updates, [[{ _id: ownerId }, { $pull: { hiddenConversations: peerId } }]]);
        assert.deepEqual(emitted, [[ownerId, "conversationRestored", { userId: peerId }]]);
    });
});

test("restore rejects the current user and never creates a duplicate conversation", async () => {
    await withDirectoryServer(async (url, { updates, emitted }) => {
        const response = await fetch(`${url}/${ownerId}/restore`, {
            method: "POST",
            headers: { authorization: "Bearer owner" }
        });
        assert.equal(response.status, 400);
        assert.deepEqual(updates, []);
        assert.deepEqual(emitted, []);
    });
});
