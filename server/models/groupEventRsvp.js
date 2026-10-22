const mongoose = require("mongoose");

const groupEventRsvpSchema = new mongoose.Schema({
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "GroupEvent", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    response: { type: String, enum: ["going", "notGoing", "maybe"], required: true }
}, { timestamps: true });

groupEventRsvpSchema.index({ eventId: 1, userId: 1 }, { unique: true });
groupEventRsvpSchema.index({ eventId: 1, response: 1 });

module.exports = mongoose.model("GroupEventRsvp", groupEventRsvpSchema);
