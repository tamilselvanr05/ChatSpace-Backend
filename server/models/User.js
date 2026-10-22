const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },

    email: {
        type: String,
        required: true,
        unique: true
    },

    password: {
        type: String,
        required: false
    },

    firebaseUid: {
        type: String,
        unique: true,
        sparse: true
    },

    blockedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],

    hiddenConversations: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],

    isDeleting: {
        type: Boolean,
        default: false
    },

    isDeleted: {
        type: Boolean,
        default: false
    },

    deletedAt: {
        type: Date,
        default: null
    },

    isOnline: {
        type: Boolean,
        default: false
    },

    showOnlineStatus: {
        type: Boolean,
        default: true
    },

    typingIndicatorEnabled: {
        type: Boolean,
        default: true
    },

    readReceiptsEnabled: {
        type: Boolean,
        default: true
    },

    about: {
    type: String,
    default: "Hey there! I am using ChatSpace.",
    maxlength: 150
},

    profilePhoto: {
        type: String,
        default: null
    }
});

const User = mongoose.model("User", userSchema);

module.exports = User;
