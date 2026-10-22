const assert = require("node:assert/strict");
const test = require("node:test");
const { parseEventDate } = require("./groupEventDate");

const NOW = Date.parse("2026-10-15T10:00:00.000Z");

test("backend group-event validation rejects past dates and past times today", () => {
    assert.equal(parseEventDate("2026-10-14T12:00:00Z", { now: NOW }), null);
    assert.equal(parseEventDate("2026-10-15T09:59:00Z", { now: NOW }), null);
});

test("backend group-event validation rejects invalid dates, times, and year 1", () => {
    for (const value of [
        "2026-02-30T12:00:00Z",
        "2026-10-15T24:00:00Z",
        "2026-10-15T10:60:00Z",
        "0001-01-01T12:00:00Z",
        "2027-10-15T10:00:00",
        "2027-10-15T10:00:00+25:00"
    ]) assert.equal(parseEventDate(value, { now: NOW }), null, value);
});

test("backend group-event validation accepts a valid future timestamp", () => {
    assert.equal(parseEventDate("2026-10-15T10:01:00Z", { now: NOW })?.toISOString(), "2026-10-15T10:01:00.000Z");
});

test("an edit may preserve its unchanged historical start but cannot move it into the past", () => {
    const existing = Date.parse("2026-10-10T12:00:00.000Z");
    assert.equal(parseEventDate("2026-10-10T12:00:00Z", { now: NOW, allowPastTimestamp: existing })?.getTime(), existing);
    assert.equal(parseEventDate("2026-10-11T12:00:00Z", { now: NOW, allowPastTimestamp: existing }), null);
});
