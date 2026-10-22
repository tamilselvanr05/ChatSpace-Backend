const User = require("./models/User");
const firebaseAuth = require("./firebaseAdmin");

const normalizeEmail = (email) => email.trim().toLowerCase();

function identityError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function findEmailMatches(email) {
    const candidates = await User.find({ email: { $type: "string" } });
    return candidates.filter((candidate) => normalizeEmail(candidate.email) === email);
}

async function findLinkedUser(uid, email) {
    const user = await User.findOne({ firebaseUid: uid });
    if (!user) return null;
    if (normalizeEmail(user.email) !== email) {
        throw identityError("The verified Firebase email does not match this ChatSpace account.", "EMAIL_MISMATCH");
    }
    return user;
}

async function linkUser(user, uid, email) {
    if (user.firebaseUid && user.firebaseUid !== uid) {
        throw identityError("This ChatSpace account is already linked to another Firebase account. Contact support to resolve the link.", "ACCOUNT_ALREADY_LINKED");
    }

    user.firebaseUid = uid;
    try {
        await user.save();
        return user;
    } catch (error) {
        if (error.code !== 11000) throw error;

        const racedUser = await findLinkedUser(uid, email);
        if (racedUser) return racedUser;
        throw identityError("This account could not be linked safely because another account changed at the same time. Please try signing in again.", "ACCOUNT_LINK_CONFLICT");
    }
}

async function resolveUsernameConflict(username, uid, email) {
    const latestEmailMatches = await findEmailMatches(email);
    if (latestEmailMatches.length > 1) {
        throw identityError("This verified email matches multiple ChatSpace accounts. Contact support to resolve the account link.", "AMBIGUOUS_EMAIL");
    }
    if (latestEmailMatches.length === 1) {
        return linkUser(latestEmailMatches[0], uid, email);
    }

    const existingUsername = await User.findOne({ username }).select("_id email");
    if (existingUsername) {
        const storedEmail = typeof existingUsername.email === "string"
            ? normalizeEmail(existingUsername.email)
            : "";
        console.info("Firebase account-link diagnostic", {
            usernameConflictFound: true,
            storedEmailMissing: !storedEmail,
            verifiedEmailMatches: Boolean(storedEmail && storedEmail === email),
            storedEmailMismatch: Boolean(storedEmail && storedEmail !== email)
        });
        throw identityError("That ChatSpace username already belongs to an account, but no account matches this verified email. Contact support to resolve the account link.", "USERNAME_LINK_REQUIRED");
    }

    throw identityError("The account could not be created safely. Please try signing in again or contact support.", "ACCOUNT_LINK_CONFLICT");
}

async function resolveFirebaseUser(token) {
    const decoded = await firebaseAuth.verifyIdToken(token);

    if (!decoded.email || decoded.email_verified !== true) {
        throw identityError("Verify your Firebase email address before using ChatSpace.", "EMAIL_NOT_VERIFIED");
    }

    const email = normalizeEmail(decoded.email);
    const linkedUser = await findLinkedUser(decoded.uid, email);
    if (linkedUser) return linkedUser;

    const emailMatches = await findEmailMatches(email);

    if (emailMatches.length > 1) {
        throw identityError("This verified email matches multiple ChatSpace accounts. Contact support to resolve the account link.", "AMBIGUOUS_EMAIL");
    }

    if (emailMatches.length === 1) {
        return linkUser(emailMatches[0], decoded.uid, email);
    }

    const firebaseUser = await firebaseAuth.getUser(decoded.uid);
    const username = firebaseUser.displayName?.trim();
    if (!username) {
        throw identityError("A ChatSpace username is required. Please complete signup again.", "USERNAME_REQUIRED");
    }

    const user = new User({
        username,
        email,
        password: `firebase:${decoded.uid}`,
        firebaseUid: decoded.uid
    });

    try {
        await user.save();
        return user;
    } catch (error) {
        if (error.code !== 11000) throw error;

        const racedUser = await findLinkedUser(decoded.uid, email);
        if (racedUser) return racedUser;

        const racedEmailMatches = await findEmailMatches(email);
        if (racedEmailMatches.length > 1) {
            throw identityError("This verified email matches multiple ChatSpace accounts. Contact support to resolve the account link.", "AMBIGUOUS_EMAIL");
        }
        if (racedEmailMatches.length === 1) {
            return linkUser(racedEmailMatches[0], decoded.uid, email);
        }

        return resolveUsernameConflict(username, decoded.uid, email);
    }
}

module.exports = { resolveFirebaseUser };
