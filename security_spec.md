# Security Specification & Red-Team Payloads

## Data Invariants
1. User PII (`email`) is strictly isolated in `/users/{userId}/private/info` and only accessible to verified `request.auth.uid == userId`.
2. Every document ID path variable (`userId`, `strategyId`, `chatId`, `messageId`, `logId`) validates against `isValidId()`.
3. Subcollection messages under `/users/{userId}/chats/{chatId}/messages/{messageId}` enforce parent existence and ownership via `get()` on the parent chat document.
4. All writes enforce verified email (`request.auth.token.email_verified == true`), strict allowlisted keys (`hasAll` + `hasOnly` on create, `affectedKeys().hasOnly()` on update), immutable ownership/timestamps (`createdAt == request.time` on create, `incoming().createdAt == existing().createdAt` & `updatedAt == request.time` on update), and explicit string length bounds.

## Dirty Dozen Adversarial Payloads
1. Unauthenticated read/write to `/users/uid1/strategies/s1` -> PERMISSION_DENIED
2. Unverified email spoofing write (`email_verified: false`) -> PERMISSION_DENIED
3. Cross-user PII read (`auth.uid = 'attacker'` reading `/users/victim/private/info`) -> PERMISSION_DENIED
4. Identity spoofing create (`ownerId: 'victim'` by `auth.uid = 'attacker'`) -> PERMISSION_DENIED
5. Shadow field injection (`isAdmin: true` on `/users/uid1`) -> PERMISSION_DENIED
6. Oversized document ID poisoning (`strategyId` length > 128 chars) -> PERMISSION_DENIED
7. Oversized `content` string (> 12000 chars) in `messages` -> PERMISSION_DENIED
8. Client timestamp tampering (`createdAt` != `request.time`) -> PERMISSION_DENIED
9. Orphaned chat message write without existing parent `/chats/{chatId}` doc -> PERMISSION_DENIED
10. Immutable `ownerId` mutation during strategy update -> PERMISSION_DENIED
11. Unbounded `list` query outside owner boundary (`/users/{other}/strategies`) -> PERMISSION_DENIED
12. Invalid `role` or `model` enum value (`model: 'unknown-model'`) -> PERMISSION_DENIED
