const test = require("node:test");
const assert = require("node:assert/strict");
const { isGroupMember, isGroupAdmin, canRemoveGroupMember, getLeaveGroupUpdate } = require("./groupManagement");

const ids = ["a", "b", "c"];

test("group management checks require membership and admin identity", () => {
    const group = { members: [ids[0], ids[1]], admin: ids[0] };
    assert.equal(isGroupMember(group, ids[1]), true);
    assert.equal(isGroupMember(group, ids[2]), false);
    assert.equal(isGroupAdmin(group, ids[0]), true);
    assert.equal(isGroupAdmin(group, ids[1]), false);
    assert.equal(isGroupAdmin(group, ids[2]), false);
    assert.equal(canRemoveGroupMember(group, ids[0], ids[1]), true);
    assert.equal(canRemoveGroupMember(group, ids[1], ids[0]), false);
    assert.equal(canRemoveGroupMember(group, ids[0], ids[2]), false);
    assert.equal(canRemoveGroupMember(null, ids[0], ids[1]), false);
});

test("leaving transfers admin to a remaining member and preserves other members", () => {
    const update = getLeaveGroupUpdate({ members: ids, admin: ids[0] }, ids[0]);
    assert.deepEqual(update, { deleteGroup: false, members: [ids[1], ids[2]], admin: ids[1] });
});

test("leaving deletes an empty group and non-admin leaving preserves admin", () => {
    assert.deepEqual(getLeaveGroupUpdate({ members: [ids[0]], admin: ids[0] }, ids[0]), {
        deleteGroup: true, members: [], admin: null
    });
    assert.deepEqual(getLeaveGroupUpdate({ members: ids, admin: ids[0] }, ids[1]), {
        deleteGroup: false, members: [ids[0], ids[2]], admin: ids[0]
    });
    const afterRemoval = { members: ids.filter((id) => id !== ids[1]), admin: ids[0] };
    assert.equal(isGroupMember(afterRemoval, ids[1]), false);
    assert.equal(isGroupMember(null, ids[1]), false);
});
