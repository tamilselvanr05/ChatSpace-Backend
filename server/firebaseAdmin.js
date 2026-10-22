const fs = require("fs");
const path = require("path");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "firebase-service-account.json");

let serviceAccount;
let serviceAccountContents;
try {
    serviceAccountContents = fs.readFileSync(serviceAccountPath, "utf8");
} catch (error) {
    const reason = error.code === "ENOENT" ? "file is missing" : "file could not be read";
    throw new Error(`Firebase Admin service account ${reason} at ${serviceAccountPath}.`);
}

try {
    serviceAccount = JSON.parse(serviceAccountContents);
} catch {
    throw new Error(`Firebase Admin service account at ${serviceAccountPath} contains invalid JSON.`);
} finally {
    serviceAccountContents = undefined;
}

if (serviceAccount.type !== "service_account") {
    throw new Error(`Firebase Admin service account at ${serviceAccountPath} must have type "service_account".`);
}

if (serviceAccount.project_id !== "chatspace-83c32") {
    throw new Error("Firebase Admin service account does not belong to the configured ChatSpace project.");
}

if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Firebase Admin service account is missing required credentials.");
}

let app;
try {
    app = getApps().length
        ? getApps()[0]
        : initializeApp({
            credential: cert(serviceAccount),
            projectId: "chatspace-83c32"
        });
} catch (error) {
    const code = typeof error.code === "string" ? ` (${error.code})` : "";
    throw new Error(`Firebase Admin could not initialize${code}. Check that the service-account credentials are valid.`);
}

module.exports = getAuth(app);
