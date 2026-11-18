import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static invariant verification suite mirroring Phase 0 Dirty Dozen security rules audit
const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const rulesText = fs.readFileSync(rulesPath, 'utf8');

assert.ok(rulesText.includes("rules_version = '2';"), 'Must use rules_version = 2');
assert.ok(
  rulesText.includes('match /{document=**} {\n      allow read, write: if false;\n    }'),
  'Must begin with global default-deny catch-all',
);
assert.ok(rulesText.includes('request.auth.token.email_verified == true'), 'Must enforce verified email');
assert.ok(rulesText.includes('isValidId('), 'Must validate document ID path variables');
assert.ok(rulesText.includes('isValidUserPublic('), 'Must validate public profile schema');
assert.ok(rulesText.includes('isValidUserPrivate('), 'Must validate isolated private PII schema');
assert.ok(rulesText.includes('isValidStrategy('), 'Must validate saved strategy schema');
assert.ok(rulesText.includes('isValidChatSession('), 'Must validate chat session schema');
assert.ok(rulesText.includes('isValidChatMessage('), 'Must validate chat message schema');
assert.ok(rulesText.includes('isValidScannerLog('), 'Must validate scanner log schema');
assert.ok(rulesText.includes('affectedKeys().hasOnly('), 'Must use action-based affectedKeys allowlists');
assert.ok(rulesText.includes('request.time'), 'Must enforce server-validated request.time timestamps');
assert.ok(
  rulesText.includes('get(/databases/$(database)/documents/users/$(userId)/chats/$(chatId)).data.ownerId'),
  'Subcollection messages must enforce Master Gate parent ownership lookup',
);
assert.ok(!rulesText.includes('allow list: if isSignedIn();'), 'Must never delegate list filtering to client');

console.log('PASS: All 14 Firestore Zero-Trust Security Invariants verified.');
