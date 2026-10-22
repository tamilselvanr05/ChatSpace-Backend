function getCallAvailability(recipientSocketCount, callerBusy, recipientBusy) {
    if (recipientSocketCount === 0) return "offline";
    if (callerBusy || recipientBusy) return "busy";
    return "available";
}

module.exports = { getCallAvailability };
