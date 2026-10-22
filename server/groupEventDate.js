const EVENT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseEventDate(value, { now = Date.now(), allowPastTimestamp = null } = {}) {
    if (typeof value !== "string") return null;
    const match = EVENT_TIMESTAMP.exec(value);
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", , zone, , zoneHourText, zoneMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const zoneHour = zoneHourText == null ? 0 : Number(zoneHourText);
    const zoneMinute = zoneMinuteText == null ? 0 : Number(zoneMinuteText);

    if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
        zoneHour > 23 || zoneMinute > 59) return null;
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day) return null;

    const date = new Date(value);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return null;
    if (timestamp < now && timestamp !== allowPastTimestamp) return null;
    return date;
}

module.exports = { parseEventDate };
