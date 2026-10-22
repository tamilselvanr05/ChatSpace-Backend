const assert = require("node:assert/strict");
const test = require("node:test");
const { getCallAvailability } = require("./callAvailability");

test("an authenticated recipient with no live sockets is offline", () => {
    assert.equal(getCallAvailability(0, false, false), "offline");
});

test("online recipients can receive calls unless either participant is busy", () => {
    assert.equal(getCallAvailability(1, false, false), "available");
    assert.equal(getCallAvailability(2, false, false), "available");
    assert.equal(getCallAvailability(1, true, false), "busy");
    assert.equal(getCallAvailability(1, false, true), "busy");
});
