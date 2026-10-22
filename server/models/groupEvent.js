const mongoose = require("mongoose");

const groupEventSchema = new mongoose.Schema({
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    startsAt: { type: Date, required: true },
    location: { type: String, default: "", maxlength: 200 },
    cancelled: { type: Boolean, default: false }
}, { timestamps: true });

groupEventSchema.index({ groupId: 1, startsAt: 1 });

module.exports = mongoose.model("GroupEvent", groupEventSchema);
