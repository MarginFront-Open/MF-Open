# User Account Cleanup Guide

This guide explains how to completely remove a user account and all associated data from the MarginFront database.

## Overview

When a user signs up (via email, Google OAuth, or GitHub OAuth), data is created across multiple tables. To fully remove an account for testing or GDPR compliance, all related records must be deleted in the correct order due to foreign key constraints.

## Database Architecture

### User-Related Tables (Direct References)

| Table | Column | Description |
|-------|--------|-------------|
| `users` | - | Main user record |
| `ba_session` | `userId` | Better Auth sessions |
| `ba_account` | `userId` | OAuth provider links (Google/GitHub) |
| `ba_member` | `userId` | Organization membership |
| `ba_invitation` | `inviterId` | Invitations sent by user |
| `tokens` | `userId` | Auth tokens |
| `user_organizations` | `userId`, `invitedBy` | Org membership projection of `ba_member` |
| `api_keys` | `createdById` | API keys created by user |

### Organization-Owned Tables (Cascade Delete)

When user owns an organization, these tables have org data:

| Table | Column | Description |
|-------|--------|-------------|
| `organizations` | `owner_id` | Organization owned by user |
| `signal_events` | `organizationId` | Usage events |
| `customers` | `organizationId` | End customers |
| `agents` | `orgId` | Billing agents |
| `signals` | `orgId` | Signal definitions |
| `subscriptions` | `orgId` | Customer subscriptions |
| `pricing_plans` | `orgId` | Pricing plans |
| `pricing_strategies` | `orgId` | Pricing strategies |
| `invoices` | `organizationId` | Generated invoices |
| `api_keys` | `organizationId` | Org API keys |
| `ba_member` | `organizationId` | Org members |
| `ba_invitation` | `organizationId` | Org invitations |

## Cleanup Command

Run from `packages/db` directory:

```bash
EMAIL="user@example.com"

# Step 1: Clean Better Auth tables
npx prisma db execute --schema=prisma/schema.prisma --stdin << EOF
DELETE FROM ba_session WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
DELETE FROM ba_account WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
DELETE FROM ba_member WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
DELETE FROM ba_invitation WHERE "inviterId" IN (SELECT id FROM users WHERE email = '$EMAIL');
EOF

# Step 2: Clean user-related tables
npx prisma db execute --schema=prisma/schema.prisma --stdin << EOF
DELETE FROM tokens WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
DELETE FROM user_organizations WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
DELETE FROM user_organizations WHERE "invitedBy" IN (SELECT id FROM users WHERE email = '$EMAIL');
EOF

# Step 3: Clean org data (for orgs OWNED by this user only)
npx prisma db execute --schema=prisma/schema.prisma --stdin << EOF
DELETE FROM signal_events WHERE "organizationId" IN (SELECT id FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL'));
DELETE FROM customers WHERE "organizationId" IN (SELECT id FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL'));
DELETE FROM ba_member WHERE "organizationId" IN (SELECT id FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL'));
DELETE FROM ba_invitation WHERE "organizationId" IN (SELECT id FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL'));
DELETE FROM api_keys WHERE "organizationId" IN (SELECT id FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL'));
DELETE FROM api_keys WHERE "createdById" IN (SELECT id FROM users WHERE email = '$EMAIL');
EOF

# Step 4: Delete organization and user
npx prisma db execute --schema=prisma/schema.prisma --stdin << EOF
DELETE FROM organizations WHERE owner_id IN (SELECT id FROM users WHERE email = '$EMAIL');
UPDATE users SET "organizationId" = NULL, current_organization_id = NULL WHERE email = '$EMAIL';
DELETE FROM users WHERE email = '$EMAIL';
EOF
```

## Multiple Accounts

To delete multiple accounts:

```bash
EMAILS=("user1@example.com" "user2@example.com" "user3@example.com")

for EMAIL in "${EMAILS[@]}"; do
  echo "Processing: $EMAIL"
  # Run the 4 steps above for each email
done
```

## Safety Notes

1. **Scoped Queries**: All DELETE statements use `WHERE email = '$EMAIL'` or subqueries that reference the specific user. No other data is affected.

2. **OAuth Cleanup**: Deleting from `ba_account` removes the Google/GitHub link, so the user will be treated as NEW on next OAuth login.

3. **Organization Ownership**: Only organizations where the user is the `owner_id` are deleted. If the user is only a member of another org, that org is NOT affected.

4. **Order Matters**: Delete in this order to avoid foreign key violations:
   - Better Auth tables first (sessions, accounts, members)
   - User-related tables (tokens, user_organizations)
   - Org-owned data (signal_events, customers, etc.)
   - Organizations
   - User (last)

## Verification

After cleanup, verify the account is gone:

```bash
npx prisma db execute --schema=prisma/schema.prisma --stdin << EOF
SELECT COUNT(*) FROM users WHERE email = '$EMAIL';
SELECT COUNT(*) FROM ba_account WHERE "userId" IN (SELECT id FROM users WHERE email = '$EMAIL');
EOF
```

Both should return 0.

## When to Use

- **Testing**: Reset test accounts to simulate fresh signup
- **GDPR**: User requests data deletion
- **Cleanup**: Remove abandoned/spam accounts
