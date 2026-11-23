-- Baseline: creates the whole MarginFront schema on an empty database.
-- Needs PostgreSQL 15 or newer (NULLS NOT DISTINCT). No extensions required.
--
-- Generated from prisma/schema.prisma with
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- then hand-edited in the three places Prisma cannot express, each marked
-- "Not expressible in schema.prisma" below, plus the reference rows at the end.
-- Regenerating this file must carry those edits forward.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "enum_api_keys_keyType" AS ENUM ('publishable', 'secret');

-- CreateEnum
CREATE TYPE "enum_api_keys_status" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "enum_blocks_status" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "enum_blocks_type" AS ENUM ('payment_info', 'payment_history', 'subscriptions', 'customer_info', 'invoices');

-- CreateEnum
CREATE TYPE "enum_customers_status" AS ENUM ('active', 'inactive', 'suspended');

-- CreateEnum
CREATE TYPE "enum_inbound_webhooks_source" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "enum_inbound_webhooks_status" AS ENUM ('pending', 'processing', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "enum_invoice_line_items_type" AS ENUM ('recurring', 'usage', 'onetime', 'tax', 'discount', 'seat_based');

-- CreateEnum
CREATE TYPE "enum_invoice_payments_paymentMethod" AS ENUM ('stripe', 'ach', 'wire', 'check', 'cash', 'other');

-- CreateEnum
CREATE TYPE "enum_invoice_payments_refund_status" AS ENUM ('none', 'partial', 'full');

-- CreateEnum
CREATE TYPE "enum_invoice_payments_status" AS ENUM ('succeeded', 'failed', 'pending');

-- CreateEnum
CREATE TYPE "enum_invoices_invoiceGenerationType" AS ENUM ('automatic', 'manual');

-- CreateEnum
CREATE TYPE "enum_invoices_invoiceType" AS ENUM ('subscription', 'usage');

-- CreateEnum
CREATE TYPE "enum_invoices_status" AS ENUM ('draft', 'pending', 'issued', 'paid', 'overdue', 'void', 'refunded');

-- CreateEnum
CREATE TYPE "enum_organizations_dashboard_mode" AS ENUM ('cost_tracking', 'revenue', 'full');

-- CreateEnum
CREATE TYPE "enum_organizations_stripe_connect_status" AS ENUM ('pending', 'active', 'restricted', 'inactive');

-- CreateEnum
CREATE TYPE "enum_payment_providers_type" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "enum_pricing_strategies_billingFrequency" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "enum_pricing_strategies_chargeType" AS ENUM ('onetime', 'recurring', 'usage', 'seat_based');

-- CreateEnum
CREATE TYPE "enum_pricing_strategies_pricingModel" AS ENUM ('graduated', 'volume', 'flat', 'credit_pool');

-- CreateEnum
CREATE TYPE "enum_raw_ingest_events_status" AS ENUM ('PENDING', 'PROCESSED', 'ERROR');

-- CreateEnum
CREATE TYPE "enum_refunds_status" AS ENUM ('pending', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "enum_signal_events_eventProcessed" AS ENUM ('PENDING', 'PROCESSED', 'ERROR', 'NEEDS_COST_BACKFILL', 'MISSING_VOLUME_DATA');

-- CreateEnum
CREATE TYPE "enum_signal_events_environment" AS ENUM ('production', 'staging', 'development', 'testing');

-- CreateEnum
CREATE TYPE "enum_signals_costCategory" AS ENUM ('PRODUCTION_COGS', 'DEVELOPMENT_RD', 'SALES_SM', 'GENERAL_GA', 'INTERNAL_TOOL', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "enum_signal_classification_overrides_source" AS ENUM ('inline_dropdown', 'bulk_suggest_button', 'api_patch');

-- CreateEnum
CREATE TYPE "enum_account_type" AS ENUM ('COGS', 'OPEX_RD', 'OPEX_GA', 'OPEX_SM');

-- CreateEnum
CREATE TYPE "enum_signals_type" AS ENUM ('usage', 'volume');

-- CreateEnum
CREATE TYPE "enum_subscription_change_logs_changeType" AS ENUM ('created', 'updated', 'status_change', 'plan_change', 'renewal');

-- CreateEnum
CREATE TYPE "enum_subscriptions_billingCycle" AS ENUM ('monthly', 'yearly', 'custom');

-- CreateEnum
CREATE TYPE "enum_subscriptions_billingmodel" AS ENUM ('subscription', 'usage', 'hybrid');

-- CreateEnum
CREATE TYPE "enum_subscriptions_status" AS ENUM ('upcoming', 'active', 'ended', 'canceled', 'expired', 'pending');

-- CreateEnum
CREATE TYPE "enum_team_invitations_role" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "enum_team_invitations_status" AS ENUM ('pending', 'accepted', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "enum_team_members_role" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "enum_team_members_status" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "enum_tokens_type" AS ENUM ('access', 'refresh', 'resetPassword', 'verifyEmail');

-- CreateEnum
CREATE TYPE "enum_user_organizations_role" AS ENUM ('member', 'owner', 'superadmin');

-- CreateEnum
CREATE TYPE "enum_users_auth_provider" AS ENUM ('local', 'google');

-- CreateEnum
CREATE TYPE "enum_users_role" AS ENUM ('member', 'owner', 'superadmin');

-- CreateEnum
CREATE TYPE "enum_users_status" AS ENUM ('active', 'blacklisted');

-- CreateEnum
CREATE TYPE "enum_matters_status" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "enum_signal_events_matterSource" AS ENUM ('tag', 'rule', 'manual');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "agentCode" VARCHAR(255) NOT NULL,
    "orgId" UUID NOT NULL,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "context" JSONB,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_usage_logs" (
    "id" UUID NOT NULL,
    "apiKeyId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestTime" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" VARCHAR(255),
    "endpoint" VARCHAR(255) NOT NULL,
    "responseStatus" INTEGER,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_key_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "apiKeyHash" VARCHAR(255) NOT NULL,
    "apiKeyPlaintext" VARCHAR(255),
    "apiKeyLookupHash" VARCHAR(64),
    "description" VARCHAR(255),
    "expiresAt" TIMESTAMPTZ(6),
    "status" "enum_api_keys_status" DEFAULT 'active',
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "permissions" JSONB DEFAULT '[]',
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "keyType" "enum_api_keys_keyType" NOT NULL DEFAULT 'secret',
    "keyPrefix" VARCHAR(15),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "type" "enum_blocks_type" NOT NULL,
    "status" "enum_blocks_status" NOT NULL DEFAULT 'active',
    "theme" JSONB NOT NULL DEFAULT '{"mode": "light", "textColor": "#1A1A1A", "errorColor": "#EF4444", "fontFamily": "system-ui", "borderColor": "#E5E5E5", "borderRadius": 8, "primaryColor": "#0066FF", "successColor": "#10B981", "backgroundColor": "#FFFFFF", "secondaryTextColor": "#6B7280"}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(255),
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(255),
    "addressLine1" VARCHAR(255),
    "addressLine2" VARCHAR(255),
    "city" VARCHAR(255),
    "state" VARCHAR(255),
    "zipCode" VARCHAR(255),
    "country" VARCHAR(255),
    "organizationId" UUID NOT NULL,
    "status" "enum_customers_status" DEFAULT 'active',
    "billingContactName" VARCHAR(255),
    "billingContactEmail" VARCHAR(255),
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "timezone" VARCHAR(255) DEFAULT 'UTC',
    "margin" JSONB DEFAULT '{}',
    "invoiceEmailRecipients" VARCHAR(255)[] DEFAULT ARRAY[]::VARCHAR(255)[],
    "netTerms" INTEGER NOT NULL DEFAULT 30,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "defaultGlCodeId" UUID,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_sessions" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" VARCHAR(255),
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "impersonatedBy" UUID,

    CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_magic_links" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_magic_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhooks" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "source" "enum_inbound_webhooks_source" NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "event_id" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "status" "enum_inbound_webhooks_status" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6),
    "processing_started_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "enum_invoice_line_items_type" NOT NULL,
    "taxCode" VARCHAR(255),
    "discountCode" VARCHAR(255),
    "pricingStrategyId" UUID,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentDate" TIMESTAMPTZ(6) NOT NULL,
    "paymentMethod" "enum_invoice_payments_paymentMethod" NOT NULL,
    "reference" VARCHAR(255),
    "notes" TEXT,
    "recordedBy" UUID,
    "metadata" JSONB DEFAULT '{}',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "enum_invoice_payments_status" NOT NULL DEFAULT 'succeeded',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "provider_transaction_id" VARCHAR(255),
    "provider_checkout_session_id" VARCHAR(255),
    "payment_provider_id" UUID,
    "provider_status" VARCHAR(50),
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "refunded_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "refund_status" "enum_invoice_payments_refund_status" NOT NULL DEFAULT 'none',
    "card_last4" VARCHAR(4),
    "card_brand" VARCHAR(20),
    "provider_fee" DECIMAL(15,2),
    "net_amount" DECIMAL(15,2),
    "receipt_url" TEXT,
    "receipt_email_sent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "subscriptionId" UUID,
    "organizationId" UUID NOT NULL,
    "invoiceDate" TIMESTAMPTZ(6) NOT NULL,
    "dueDate" TIMESTAMPTZ(6) NOT NULL,
    "billingPeriodStart" TIMESTAMPTZ(6) NOT NULL,
    "billingPeriodEnd" TIMESTAMPTZ(6) NOT NULL,
    "invoiceType" "enum_invoices_invoiceType" NOT NULL DEFAULT 'subscription',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) DEFAULT 0,
    "discountAmount" DECIMAL(12,2) DEFAULT 0,
    "status" "enum_invoices_status" DEFAULT 'draft',
    "invoiceNumber" VARCHAR(255) NOT NULL,
    "pdfUrl" VARCHAR(255),
    "metadata" JSONB DEFAULT '{}',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "netTerms" INTEGER NOT NULL DEFAULT 30,
    "amountPaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountCredited" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "statusReason" VARCHAR(255),
    "pdfSha256" VARCHAR(255),
    "autoCollectPayment" BOOLEAN NOT NULL DEFAULT false,
    "isFinalizedUsage" BOOLEAN DEFAULT false,
    "lastUsageUpdateAt" TIMESTAMPTZ(6),
    "invoiceGenerationType" "enum_invoices_invoiceGenerationType" NOT NULL DEFAULT 'automatic',
    "memo" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "reminderStage" VARCHAR(20) DEFAULT 'none',
    "reminderCount" INTEGER DEFAULT 0,
    "lastReminderSentAt" TIMESTAMPTZ(6),
    "nextReminderDate" DATE,
    "reminderPaused" BOOLEAN DEFAULT false,
    "escalatedAt" TIMESTAMPTZ(6),
    "escalationReason" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(255),
    "organizationInfo" TEXT,
    "website" VARCHAR(255),
    "linkedin" VARCHAR(255),
    "logo" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timezone" VARCHAR(255) NOT NULL DEFAULT 'UTC',
    "tagline" VARCHAR(255),
    "address_line1" VARCHAR(255),
    "address_line2" VARCHAR(255),
    "city" VARCHAR(255),
    "state" VARCHAR(255),
    "zip_code" VARCHAR(255),
    "country" VARCHAR(255),
    "billing_email" VARCHAR(255),
    "billing_phone" VARCHAR(255),
    "default_currency" VARCHAR(255) DEFAULT 'USD',
    "designjson" JSONB DEFAULT '{"textColor": "#FFFFFF", "headerColor": "#2B3990"}',
    "stripe_connect_account_id" VARCHAR(255),
    "stripe_connect_type" VARCHAR(255) DEFAULT 'standard',
    "stripe_connect_charges_enabled" BOOLEAN DEFAULT false,
    "stripe_connect_details_submitted" BOOLEAN DEFAULT false,
    "stripe_connect_requirements" JSONB DEFAULT '{}',
    "stripe_connect_onboarding_url" VARCHAR(255),
    "stripe_connect_onboarding_url_expires" TIMESTAMPTZ(6),
    "owner_id" UUID,
    "max_team_size" INTEGER,
    "team_features" JSONB DEFAULT '{}',
    "stripe_connect_status" "enum_organizations_stripe_connect_status",
    "onboarding_complete" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_step" VARCHAR(255),
    "dashboard_mode" "enum_organizations_dashboard_mode",
    "setup_method" VARCHAR(50),
    "theme" JSONB,
    "billingIdentity" JSONB,
    "roiAssumptions" JSONB,
    "stripeAutomaticTax" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "enum_payment_providers_type" NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "encrypted_secrets" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_plans" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(255),
    "featuresList" JSONB,
    "agentId" UUID,
    "orgId" UUID NOT NULL,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "pricing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_pricing_plans" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pricing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_strategies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "agentId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "signalId" UUID,
    "tags" JSONB DEFAULT '[]',
    "chargeType" "enum_pricing_strategies_chargeType" NOT NULL,
    "pricingModel" "enum_pricing_strategies_pricingModel",
    "billingFrequency" "enum_pricing_strategies_billingFrequency",
    "tiers" JSONB,
    "rate" DECIMAL(18,6),
    "creditRates" JSONB,
    "active" BOOLEAN DEFAULT true,
    "minimumCommitment" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "pricing_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_ingest_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "enum_raw_ingest_events_status" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "processedAt" TIMESTAMPTZ(6),
    "errorMsg" TEXT,
    "eventId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "raw_ingest_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "invoice_payment_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "reason" VARCHAR(100),
    "status" "enum_refunds_status" NOT NULL DEFAULT 'pending',
    "provider_refund_id" VARCHAR(255),
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "refunded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_events" (
    "id" UUID NOT NULL,
    "customerExternalId" VARCHAR(255) NOT NULL,
    "customerId" UUID NOT NULL,
    "subscriptionId" UUID,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "signalId" UUID,
    "rawIngestEventId" UUID NOT NULL,
    "usageDate" TIMESTAMPTZ(6) NOT NULL,
    "quantity" DECIMAL(18,6) DEFAULT 1,
    "metadata" JSONB DEFAULT '{}',
    "usageCost" DECIMAL(18,6),
    "usageCostData" JSONB,
    "eventProcessed" "enum_signal_events_eventProcessed" NOT NULL DEFAULT 'PENDING',
    "eventProcessedAt" TIMESTAMPTZ(6),
    "environment" "enum_signal_events_environment",
    "idempotencyKey" VARCHAR(255),
    "matterId" UUID,
    "matterSource" "enum_signal_events_matterSource",
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "shortName" VARCHAR(255),
    "agentId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "type" "enum_signals_type",
    "costCategory" "enum_signals_costCategory" NOT NULL DEFAULT 'UNCLASSIFIED',
    "glCodeId" UUID,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_change_logs" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "changedBy" UUID NOT NULL,
    "changeType" "enum_subscription_change_logs_changeType" NOT NULL,
    "previousValues" JSONB,
    "newValues" JSONB,
    "changeReason" VARCHAR(255),
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "customerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "startDate" TIMESTAMPTZ(6) NOT NULL,
    "endDate" TIMESTAMPTZ(6),
    "isForever" BOOLEAN DEFAULT false,
    "status" "enum_subscriptions_status" DEFAULT 'pending',
    "subscriptionDetails" JSONB DEFAULT '{}',
    "billingCycle" "enum_subscriptions_billingCycle" DEFAULT 'monthly',
    "proratedAmount" DECIMAL(10,6),
    "cycleNumber" INTEGER NOT NULL DEFAULT 0,
    "timezone" VARCHAR(255) NOT NULL DEFAULT 'UTC',
    "currentBillingPeriodStart" TIMESTAMPTZ(6),
    "currentBillingPeriodEnd" TIMESTAMPTZ(6),
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "nextRecurringInvoiceAt" TIMESTAMPTZ(6) NOT NULL,
    "nextUsageInvoiceAt" TIMESTAMPTZ(6) NOT NULL,
    "customCycleDays" INTEGER,
    "currentSubscriptionDraftInvoiceId" UUID,
    "currentUsageDraftInvoiceId" UUID,
    "subscriptionInvoiceIssuanceDate" TIMESTAMPTZ(6),
    "seatsCount" INTEGER DEFAULT 0,
    "seatsInfo" JSONB DEFAULT '{}',
    "billingDay" INTEGER,
    "netTerms" INTEGER DEFAULT 30,
    "autoCollectPayment" BOOLEAN DEFAULT false,
    "invoiceMemo" TEXT,
    "organizationId" UUID,
    "billingModel" "enum_subscriptions_billingmodel" DEFAULT 'subscription',
    "creditAlertsPaused" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" "enum_team_invitations_role" NOT NULL DEFAULT 'member',
    "token" VARCHAR(255) NOT NULL,
    "invited_by" UUID NOT NULL,
    "status" "enum_team_invitations_status" NOT NULL DEFAULT 'pending',
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "enum_team_members_role" NOT NULL DEFAULT 'member',
    "status" "enum_team_members_status" NOT NULL DEFAULT 'active',
    "invited_by" UUID,
    "joined_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "type" "enum_tokens_type" NOT NULL,
    "expires" TIMESTAMPTZ(6) NOT NULL,
    "blacklisted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_organizations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "role" "enum_user_organizations_role" NOT NULL DEFAULT 'member',
    "isDefault" BOOLEAN DEFAULT false,
    "joinedAt" TIMESTAMPTZ(6) NOT NULL,
    "invitedBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "image" TEXT,
    "password" VARCHAR(255),
    "role" "enum_users_role" DEFAULT 'member',
    "isEmailVerified" BOOLEAN DEFAULT false,
    "status" "enum_users_status" NOT NULL DEFAULT 'active',
    "otp" VARCHAR(255),
    "otpExpiresAt" TIMESTAMPTZ(6),
    "lastOtpSentAt" TIMESTAMPTZ(6),
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "organizationId" UUID,
    "current_organization_id" UUID,
    "last_organization_switch" TIMESTAMPTZ(6),
    "google_id" VARCHAR(255),
    "auth_provider" "enum_users_auth_provider" NOT NULL DEFAULT 'local',
    "persona" VARCHAR(50),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_session" (
    "id" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" VARCHAR(255),
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "activeOrganizationId" UUID,
    "impersonatedBy" VARCHAR(255),

    CONSTRAINT "ba_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_account" (
    "id" VARCHAR(255) NOT NULL,
    "accountId" VARCHAR(255) NOT NULL,
    "providerId" VARCHAR(255) NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ba_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_verification" (
    "id" VARCHAR(255) NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "ba_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_jwks" (
    "id" VARCHAR(255) NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ba_jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_member" (
    "id" VARCHAR(255) NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ba_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ba_invitation" (
    "id" VARCHAR(255) NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'member',
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviterId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ba_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_pricing" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(255) NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "serviceType" VARCHAR(50) NOT NULL,
    "inputCost" DECIMAL(18,10),
    "outputCost" DECIMAL(18,10),
    "cacheReadCost" DECIMAL(18,10),
    "cacheWriteCost" DECIMAL(18,10),
    "costUnit" VARCHAR(50) NOT NULL,
    "contextWindow" INTEGER,
    "source" VARCHAR(50) NOT NULL,
    "isApi" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "canonicalName" VARCHAR(255) NOT NULL,

    CONSTRAINT "service_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_services" (
    "id" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "servicePricingId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_event_services" (
    "id" UUID NOT NULL,
    "signalEventId" UUID NOT NULL,
    "model" VARCHAR(255) NOT NULL,
    "modelProvider" VARCHAR(100) NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "quantity" DECIMAL(18,6),
    "servicePricingId" UUID,
    "usageCost" DECIMAL(18,6),
    "usageCostData" JSONB,
    "eventStatus" "enum_signal_events_eventProcessed" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_event_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_model_mappings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceModel" VARCHAR(255) NOT NULL,
    "sourceProvider" VARCHAR(100) NOT NULL,
    "targetPricingId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_model_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_throttle" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_throttle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_classification_rules" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "pattern" VARCHAR(255) NOT NULL,
    "category" "enum_signals_costCategory" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "agentId" UUID,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_classification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_of_accounts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "glCode" VARCHAR(50) NOT NULL,
    "glName" VARCHAR(255) NOT NULL,
    "costCategory" "enum_signals_costCategory" NOT NULL,
    "accountingType" "enum_account_type" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "description" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_classification_overrides" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "signalNameSnapshot" VARCHAR(255) NOT NULL,
    "agentIdSnapshot" UUID,
    "suggestedCategory" "enum_signals_costCategory",
    "chosenCategory" "enum_signals_costCategory" NOT NULL,
    "userId" UUID,
    "source" "enum_signal_classification_overrides_source" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_classification_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_period_locks" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "periodLabel" VARCHAR(255) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotVersion" INTEGER NOT NULL DEFAULT 1,
    "lockedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedByUserId" UUID,

    CONSTRAINT "finance_period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_period_lock_events" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "periodLabel" VARCHAR(255) NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_period_lock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_dashboard_layouts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "page" VARCHAR(50) NOT NULL,
    "tiles" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_dashboard_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_saved_views" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "initiatives" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(1000),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "startDate" TIMESTAMPTZ(6) NOT NULL,
    "endDate" TIMESTAMPTZ(6),
    "matterId" UUID,
    "scopedMatterNumber" VARCHAR(255),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "initiatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "initiative_targets" (
    "id" UUID NOT NULL,
    "initiativeId" UUID NOT NULL,
    "metric" VARCHAR(50) NOT NULL,
    "targetValue" DECIMAL(18,6) NOT NULL,
    "baselineValue" DECIMAL(18,6),
    "baselineSource" VARCHAR(10),
    "direction" VARCHAR(4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "initiative_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cap_policies" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "scopeValue" VARCHAR(255),
    "providerScope" VARCHAR(50) NOT NULL,
    "amountUsd" DECIMAL(18,6) NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "coolOffHours" INTEGER,
    -- Not expressible in schema.prisma: NOT NULL on a list column.
    "alertThresholds" INTEGER[] NOT NULL DEFAULT ARRAY[50, 80, 100]::INTEGER[],
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cap_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cap_policy_events" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "capPolicyId" UUID,
    "action" VARCHAR(20) NOT NULL,
    "previousValues" JSONB,
    "newValues" JSONB,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cap_policy_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cap_alert_events" (
    "id" UUID NOT NULL,
    "capPolicyId" UUID NOT NULL,
    "rung" INTEGER NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient" VARCHAR(255) NOT NULL,

    CONSTRAINT "cap_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "amountUnits" DECIMAL(18,6) NOT NULL,
    "consumedUnits" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "source" VARCHAR(30) NOT NULL,
    "periodStart" TIMESTAMPTZ(6),
    "effectiveAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6),
    "idempotencyKey" VARCHAR(255),
    "note" TEXT,
    "createdBy" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "deltaUnits" DECIMAL(18,6) NOT NULL,
    "balanceAfterUnits" DECIMAL(18,6) NOT NULL,
    "signalEventId" UUID,
    "rateApplied" DECIMAL(18,6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_pool_balances" (
    "subscriptionId" UUID NOT NULL,
    "balanceUnits" DECIMAL(18,6) NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_pool_balances_pkey" PRIMARY KEY ("subscriptionId")
);

-- CreateTable
CREATE TABLE "pool_alert_events" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "stage" VARCHAR(20) NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient" VARCHAR(255) NOT NULL,

    CONSTRAINT "pool_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_alerts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "metric" VARCHAR(20) NOT NULL,
    "thresholdUsd" DECIMAL(18,6) NOT NULL,
    "windowMode" VARCHAR(20) NOT NULL,
    "customStartDate" TIMESTAMPTZ(6),
    "customEndDate" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "recipientEmail" VARCHAR(255) NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "triggeredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_alert_events" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "valueUsd" DECIMAL(18,6) NOT NULL,
    "recipient" VARCHAR(255) NOT NULL,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_alert_notifications" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "metric" VARCHAR(20) NOT NULL,
    "thresholdUsd" DECIMAL(18,6) NOT NULL,
    "valueUsd" DECIMAL(18,6) NOT NULL,
    "windowMode" VARCHAR(20) NOT NULL,
    "firedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(6),

    CONSTRAINT "customer_alert_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matters" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "matterNumber" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "clientName" VARCHAR(255) NOT NULL,
    "status" "enum_matters_status" NOT NULL DEFAULT 'open',
    "responsibleUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matter_routing_rules" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "matterId" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "agentCode" VARCHAR(255),
    "customerExternalId" VARCHAR(255),
    "signalPattern" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matter_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_context_idx" ON "agents" USING GIN ("context");

-- CreateIndex
CREATE UNIQUE INDEX "agents_agentCode_orgId_key" ON "agents"("agentCode", "orgId");

-- CreateIndex
CREATE INDEX "idx_api_usage_key" ON "api_key_usage_logs"("apiKeyId");

-- CreateIndex
CREATE INDEX "idx_api_usage_org" ON "api_key_usage_logs"("organizationId");

-- CreateIndex
CREATE INDEX "idx_api_usage_time" ON "api_key_usage_logs"("requestTime");

-- CreateIndex
CREATE INDEX "idx_api_keys_key_type" ON "api_keys"("keyType");

-- CreateIndex
CREATE INDEX "idx_api_keys_org_type" ON "api_keys"("organizationId", "keyType");

-- CreateIndex
CREATE INDEX "idx_api_keys_lookup_hash" ON "api_keys"("apiKeyLookupHash");

-- CreateIndex
CREATE INDEX "idx_blocks_agent_id" ON "blocks"("agent_id");

-- CreateIndex
CREATE INDEX "idx_blocks_org_id" ON "blocks"("organization_id");

-- CreateIndex
CREATE INDEX "idx_blocks_status" ON "blocks"("status");

-- CreateIndex
CREATE INDEX "idx_blocks_type" ON "blocks"("type");

-- CreateIndex
CREATE INDEX "idx_customers_external_org" ON "customers"("externalId", "organizationId");

-- CreateIndex
CREATE INDEX "idx_customers_invoice_email_recipients" ON "customers" USING GIN ("invoiceEmailRecipients");

-- CreateIndex
CREATE INDEX "idx_customers_margin" ON "customers" USING GIN ("margin");

-- CreateIndex
CREATE INDEX "idx_customers_net_terms" ON "customers"("netTerms");

-- CreateIndex
CREATE UNIQUE INDEX "customers_externalId_organizationId_key" ON "customers"("externalId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "portal_sessions_token_key" ON "portal_sessions"("token");

-- CreateIndex
CREATE INDEX "portal_sessions_customerId_idx" ON "portal_sessions"("customerId");

-- CreateIndex
CREATE INDEX "portal_sessions_organizationId_idx" ON "portal_sessions"("organizationId");

-- CreateIndex
CREATE INDEX "portal_sessions_token_idx" ON "portal_sessions"("token");

-- CreateIndex
CREATE INDEX "portal_sessions_expiresAt_idx" ON "portal_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "portal_sessions_impersonatedBy_idx" ON "portal_sessions"("impersonatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "portal_magic_links_token_key" ON "portal_magic_links"("token");

-- CreateIndex
CREATE INDEX "portal_magic_links_token_idx" ON "portal_magic_links"("token");

-- CreateIndex
CREATE INDEX "portal_magic_links_customerId_idx" ON "portal_magic_links"("customerId");

-- CreateIndex
CREATE INDEX "portal_magic_links_expiresAt_idx" ON "portal_magic_links"("expiresAt");

-- CreateIndex
CREATE INDEX "idx_inbound_webhooks_event_type" ON "inbound_webhooks"("event_type");

-- CreateIndex
CREATE INDEX "idx_inbound_webhooks_org_id" ON "inbound_webhooks"("organization_id");

-- CreateIndex
CREATE INDEX "idx_inbound_webhooks_source_event_id" ON "inbound_webhooks"("source", "event_id");

-- CreateIndex
CREATE INDEX "idx_inbound_webhooks_status" ON "inbound_webhooks"("status");

-- CreateIndex
CREATE INDEX "idx_invoice_line_items_invoice_id" ON "invoice_line_items"("invoiceId");

-- CreateIndex
CREATE INDEX "idx_invoice_line_items_pricing_strategy_id" ON "invoice_line_items"("pricingStrategyId");

-- CreateIndex
CREATE INDEX "idx_invoice_payments_checkout_session" ON "invoice_payments"("provider_checkout_session_id");

-- CreateIndex
CREATE INDEX "idx_invoice_payments_provider_tx_id" ON "invoice_payments"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "idx_invoice_payments_payment_date" ON "invoice_payments"("paymentDate");

-- CreateIndex
CREATE INDEX "idx_invoices_customer_id" ON "invoices"("customerId");

-- CreateIndex
CREATE INDEX "idx_invoices_due_date" ON "invoices"("dueDate");

-- CreateIndex
CREATE INDEX "idx_invoices_escalated" ON "invoices"("escalatedAt");

-- CreateIndex
CREATE INDEX "idx_invoices_generation_type" ON "invoices"("invoiceGenerationType");

-- CreateIndex
CREATE INDEX "idx_invoices_invoice_date" ON "invoices"("invoiceDate");

-- CreateIndex
CREATE INDEX "idx_invoices_is_finalized_usage" ON "invoices"("isFinalizedUsage");

-- CreateIndex
CREATE INDEX "idx_invoices_last_usage_update" ON "invoices"("lastUsageUpdateAt");

-- CreateIndex
CREATE INDEX "idx_invoices_reminder_due" ON "invoices"("nextReminderDate", "status", "reminderPaused");

-- CreateIndex
CREATE INDEX "idx_invoices_reminder_stage" ON "invoices"("reminderStage");

-- CreateIndex
CREATE INDEX "idx_invoices_status" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "idx_invoices_subscription_id" ON "invoices"("subscriptionId");

-- CreateIndex
CREATE INDEX "idx_invoices_subscription_type_period" ON "invoices"("subscriptionId", "invoiceType", "billingPeriodStart");

-- CreateIndex
CREATE INDEX "idx_invoices_type" ON "invoices"("invoiceType");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_org_invoiceNumber_unique" ON "invoices"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "idx_payment_providers_org_id" ON "payment_providers"("organization_id");

-- CreateIndex
CREATE INDEX "idx_payment_providers_type" ON "payment_providers"("type");

-- CreateIndex
CREATE INDEX "agent_pricing_plans_agentId_idx" ON "agent_pricing_plans"("agentId");

-- CreateIndex
CREATE INDEX "agent_pricing_plans_planId_idx" ON "agent_pricing_plans"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_pricing_plans_agentId_planId_key" ON "agent_pricing_plans"("agentId", "planId");

-- CreateIndex
CREATE INDEX "pricing_strategies_planId_idx" ON "pricing_strategies"("planId");

-- CreateIndex
CREATE INDEX "idx_raw_ingest_events_org" ON "raw_ingest_events"("organizationId");

-- CreateIndex
CREATE INDEX "idx_raw_ingest_events_org_status_created" ON "raw_ingest_events"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "idx_raw_ingest_events_payload_gin" ON "raw_ingest_events" USING GIN ("payload" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "idx_raw_ingest_events_received_at" ON "raw_ingest_events"("receivedAt");

-- CreateIndex
CREATE INDEX "idx_raw_ingest_events_status" ON "raw_ingest_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds"("provider_refund_id");

-- CreateIndex
CREATE INDEX "idx_refunds_payment_id" ON "refunds"("invoice_payment_id");

-- CreateIndex
CREATE INDEX "idx_refunds_provider_id" ON "refunds"("provider_refund_id");

-- CreateIndex
CREATE INDEX "idx_refunds_status" ON "refunds"("status");

-- CreateIndex
CREATE INDEX "idx_signal_events_agent" ON "signal_events"("agentId");

-- CreateIndex
CREATE INDEX "idx_signal_events_customer" ON "signal_events"("customerExternalId");

-- CreateIndex
CREATE INDEX "idx_signal_events_customer_subscription" ON "signal_events"("customerId", "subscriptionId");

-- CreateIndex
CREATE INDEX "idx_signal_events_date" ON "signal_events"("usageDate");

-- CreateIndex
CREATE INDEX "idx_signal_events_event_processed" ON "signal_events"("eventProcessed");

-- CreateIndex
CREATE INDEX "idx_signal_events_org" ON "signal_events"("organizationId");

-- CreateIndex
CREATE INDEX "idx_signal_events_environment" ON "signal_events"("environment");

-- CreateIndex
CREATE INDEX "idx_signal_events_org_usage_date" ON "signal_events"("organizationId", "usageDate");

-- CreateIndex
CREATE INDEX "idx_signal_events_org_matter" ON "signal_events"("organizationId", "matterId");

-- CreateIndex
CREATE UNIQUE INDEX "uq_signal_events_org_idempotency" ON "signal_events"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "signals_agentId_name_key" ON "signals"("agentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "signals_agentId_shortName_key" ON "signals"("agentId", "shortName");

-- CreateIndex
CREATE INDEX "idx_subscriptions_agent_customer_status" ON "subscriptions"("agentId", "customerId", "status");

-- CreateIndex
CREATE INDEX "idx_subscriptions_current_billing_period" ON "subscriptions"("currentBillingPeriodStart", "currentBillingPeriodEnd");

-- CreateIndex
CREATE INDEX "idx_subscriptions_customer_status" ON "subscriptions"("customerId", "status");

-- CreateIndex
CREATE INDEX "idx_subscriptions_end_date" ON "subscriptions"("endDate");

-- CreateIndex
CREATE INDEX "idx_subscriptions_next_recurring_invoice" ON "subscriptions"("nextRecurringInvoiceAt");

-- CreateIndex
CREATE INDEX "idx_subscriptions_next_usage_invoice" ON "subscriptions"("nextUsageInvoiceAt");

-- CreateIndex
CREATE INDEX "idx_subscriptions_start_date" ON "subscriptions"("startDate");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status_end_date" ON "subscriptions"("status", "endDate");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status_start_date" ON "subscriptions"("status", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "team_invitations_token_key" ON "team_invitations"("token");

-- CreateIndex
CREATE INDEX "idx_invitations_email" ON "team_invitations"("email");

-- CreateIndex
CREATE INDEX "idx_invitations_org_id" ON "team_invitations"("organization_id");

-- CreateIndex
CREATE INDEX "idx_invitations_status" ON "team_invitations"("status");

-- CreateIndex
CREATE INDEX "idx_invitations_token" ON "team_invitations"("token");

-- CreateIndex
CREATE INDEX "team_invitations_email" ON "team_invitations"("email");

-- CreateIndex
CREATE INDEX "team_invitations_organization_id" ON "team_invitations"("organization_id");

-- CreateIndex
CREATE INDEX "team_invitations_status" ON "team_invitations"("status");

-- CreateIndex
CREATE INDEX "team_invitations_token" ON "team_invitations"("token");

-- CreateIndex
CREATE INDEX "idx_team_members_org_id" ON "team_members"("organization_id");

-- CreateIndex
CREATE INDEX "idx_team_members_role" ON "team_members"("role");

-- CreateIndex
CREATE INDEX "idx_team_members_status" ON "team_members"("status");

-- CreateIndex
CREATE INDEX "idx_team_members_user_id" ON "team_members"("user_id");

-- CreateIndex
CREATE INDEX "team_members_organization_id" ON "team_members"("organization_id");

-- CreateIndex
CREATE INDEX "team_members_role" ON "team_members"("role");

-- CreateIndex
CREATE INDEX "team_members_status" ON "team_members"("status");

-- CreateIndex
CREATE INDEX "team_members_user_id" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_team_members_user_org_unique" ON "team_members"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_user_id_organization_id" ON "team_members"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_token_key" ON "tokens"("token");

-- CreateIndex
CREATE INDEX "tokens_token" ON "tokens"("token");

-- CreateIndex
CREATE INDEX "tokens_user_id" ON "tokens"("userId");

-- CreateIndex
CREATE INDEX "user_organization_default_idx" ON "user_organizations"("isDefault", "userId");

-- CreateIndex
CREATE INDEX "user_organization_organization_idx" ON "user_organizations"("organizationId");

-- CreateIndex
CREATE INDEX "user_organization_user_idx" ON "user_organizations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_organization_unique" ON "user_organizations"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_organizations_userId_organizationId_key" ON "user_organizations"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE INDEX "idx_users_current_org" ON "users"("current_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "ba_session_token_key" ON "ba_session"("token");

-- CreateIndex
CREATE INDEX "ba_session_userId_idx" ON "ba_session"("userId");

-- CreateIndex
CREATE INDEX "ba_session_token_idx" ON "ba_session"("token");

-- CreateIndex
CREATE INDEX "ba_account_userId_idx" ON "ba_account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ba_account_providerId_accountId_key" ON "ba_account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "ba_verification_identifier_idx" ON "ba_verification"("identifier");

-- CreateIndex
CREATE INDEX "ba_member_userId_idx" ON "ba_member"("userId");

-- CreateIndex
CREATE INDEX "ba_member_organizationId_idx" ON "ba_member"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ba_member_organizationId_userId_key" ON "ba_member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ba_invitation_organizationId_idx" ON "ba_invitation"("organizationId");

-- CreateIndex
CREATE INDEX "ba_invitation_email_idx" ON "ba_invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "service_pricing_externalId_key" ON "service_pricing"("externalId");

-- CreateIndex
CREATE INDEX "service_pricing_serviceType_idx" ON "service_pricing"("serviceType");

-- CreateIndex
CREATE INDEX "service_pricing_provider_idx" ON "service_pricing"("provider");

-- CreateIndex
CREATE INDEX "service_pricing_source_idx" ON "service_pricing"("source");

-- CreateIndex
CREATE INDEX "service_pricing_provider_canonicalName_isActive_idx" ON "service_pricing"("provider", "canonicalName", "isActive");

-- CreateIndex
CREATE INDEX "signal_services_signalId_idx" ON "signal_services"("signalId");

-- CreateIndex
CREATE INDEX "signal_services_servicePricingId_idx" ON "signal_services"("servicePricingId");

-- CreateIndex
CREATE UNIQUE INDEX "signal_services_signalId_servicePricingId_key" ON "signal_services"("signalId", "servicePricingId");

-- CreateIndex
CREATE INDEX "idx_signal_event_services_event" ON "signal_event_services"("signalEventId");

-- CreateIndex
CREATE INDEX "idx_signal_event_services_pricing" ON "signal_event_services"("servicePricingId");

-- CreateIndex
CREATE INDEX "idx_signal_event_services_model" ON "signal_event_services"("model", "modelProvider");

-- CreateIndex
CREATE INDEX "idx_signal_event_services_status" ON "signal_event_services"("eventStatus");

-- CreateIndex
CREATE INDEX "org_model_mappings_organizationId_sourceModel_sourceProvide_idx" ON "org_model_mappings"("organizationId", "sourceModel", "sourceProvider");

-- CreateIndex
CREATE UNIQUE INDEX "org_model_mappings_organizationId_sourceModel_sourceProvide_key" ON "org_model_mappings"("organizationId", "sourceModel", "sourceProvider");

-- CreateIndex
CREATE UNIQUE INDEX "app_throttle_key_key" ON "app_throttle"("key");

-- CreateIndex
CREATE INDEX "app_throttle_key_idx" ON "app_throttle"("key");

-- CreateIndex
CREATE INDEX "signal_classification_rules_orgId_priority_idx" ON "signal_classification_rules"("orgId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "signal_classification_rules_orgId_pattern_agentId_key" ON "signal_classification_rules"("orgId", "pattern", "agentId");

-- CreateIndex
CREATE INDEX "chart_of_accounts_orgId_idx" ON "chart_of_accounts"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_orgId_glCode_key" ON "chart_of_accounts"("orgId", "glCode");

-- CreateIndex
CREATE INDEX "signal_classification_overrides_orgId_createdAt_idx" ON "signal_classification_overrides"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "signal_classification_overrides_signalId_idx" ON "signal_classification_overrides"("signalId");

-- CreateIndex
CREATE INDEX "finance_period_locks_orgId_periodStart_idx" ON "finance_period_locks"("orgId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "finance_period_locks_orgId_periodStart_periodEnd_key" ON "finance_period_locks"("orgId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "finance_period_lock_events_orgId_periodStart_idx" ON "finance_period_lock_events"("orgId", "periodStart");

-- CreateIndex
CREATE INDEX "user_dashboard_layouts_orgId_idx" ON "user_dashboard_layouts"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "user_dashboard_layouts_userId_orgId_page_key" ON "user_dashboard_layouts"("userId", "orgId", "page");

-- CreateIndex
CREATE INDEX "user_saved_views_userId_orgId_idx" ON "user_saved_views"("userId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "user_saved_views_userId_orgId_name_key" ON "user_saved_views"("userId", "orgId", "name");

-- CreateIndex
CREATE INDEX "initiatives_orgId_status_idx" ON "initiatives"("orgId", "status");

-- CreateIndex
CREATE INDEX "initiatives_matterId_idx" ON "initiatives"("matterId");

-- CreateIndex
CREATE INDEX "initiative_targets_initiativeId_idx" ON "initiative_targets"("initiativeId");

-- CreateIndex
CREATE INDEX "cap_policies_orgId_idx" ON "cap_policies"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "cap_policies_orgId_scope_scopeValue_providerScope_key" ON "cap_policies"("orgId", "scope", "scopeValue", "providerScope");

-- CreateIndex
CREATE INDEX "cap_policy_events_orgId_createdAt_idx" ON "cap_policy_events"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cap_alert_events_capPolicyId_rung_windowStart_key" ON "cap_alert_events"("capPolicyId", "rung", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_idempotencyKey_key" ON "credit_grants"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_grants_subscriptionId_expiresAt_idx" ON "credit_grants"("subscriptionId", "expiresAt");

-- CreateIndex
CREATE INDEX "credit_grants_organizationId_idx" ON "credit_grants"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_subscriptionId_periodStart_key" ON "credit_grants"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_subscriptionId_createdAt_idx" ON "credit_ledger_entries"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entries_signalEventId_grantId_key" ON "credit_ledger_entries"("signalEventId", "grantId");

-- CreateIndex
CREATE INDEX "pool_alert_events_organizationId_idx" ON "pool_alert_events"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "pool_alert_events_subscriptionId_stage_periodStart_key" ON "pool_alert_events"("subscriptionId", "stage", "periodStart");

-- CreateIndex
CREATE INDEX "customer_alerts_orgId_idx" ON "customer_alerts"("orgId");

-- CreateIndex
CREATE INDEX "customer_alerts_customerId_idx" ON "customer_alerts"("customerId");

-- CreateIndex
-- Not expressible in schema.prisma: NULLS NOT DISTINCT, so two watches whose
-- custom dates are both NULL still count as duplicates.
CREATE UNIQUE INDEX "uq_customer_alerts_functional_tuple" ON "customer_alerts"("orgId", "customerId", "metric", "windowMode", "thresholdUsd", "recipientUserId", "customStartDate", "customEndDate") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "customer_alert_events_alertId_windowStart_key" ON "customer_alert_events"("alertId", "windowStart");

-- CreateIndex
CREATE INDEX "customer_alert_notifications_userId_readAt_idx" ON "customer_alert_notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "customer_alert_notifications_orgId_idx" ON "customer_alert_notifications"("orgId");

-- CreateIndex
CREATE INDEX "matters_orgId_status_idx" ON "matters"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "matters_orgId_matterNumber_key" ON "matters"("orgId", "matterNumber");

-- CreateIndex
CREATE INDEX "matter_routing_rules_orgId_priority_idx" ON "matter_routing_rules"("orgId", "priority");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_usage_logs" ADD CONSTRAINT "api_key_usage_logs_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_usage_logs" ADD CONSTRAINT "api_key_usage_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_defaultGlCodeId_fkey" FOREIGN KEY ("defaultGlCodeId") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_impersonatedBy_fkey" FOREIGN KEY ("impersonatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_magic_links" ADD CONSTRAINT "portal_magic_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_magic_links" ADD CONSTRAINT "portal_magic_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_pricingStrategyId_fkey" FOREIGN KEY ("pricingStrategyId") REFERENCES "pricing_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_payment_provider_id_fkey" FOREIGN KEY ("payment_provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_recordedBy_fkey" FOREIGN KEY ("recordedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_providers" ADD CONSTRAINT "payment_providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pricing_plans" ADD CONSTRAINT "pricing_plans_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_plans" ADD CONSTRAINT "pricing_plans_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pricing_plans" ADD CONSTRAINT "agent_pricing_plans_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pricing_plans" ADD CONSTRAINT "agent_pricing_plans_planId_fkey" FOREIGN KEY ("planId") REFERENCES "pricing_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_strategies" ADD CONSTRAINT "pricing_strategies_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_strategies" ADD CONSTRAINT "pricing_strategies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_strategies" ADD CONSTRAINT "pricing_strategies_planId_fkey" FOREIGN KEY ("planId") REFERENCES "pricing_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_strategies" ADD CONSTRAINT "pricing_strategies_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_ingest_events" ADD CONSTRAINT "raw_ingest_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_payment_id_fkey" FOREIGN KEY ("invoice_payment_id") REFERENCES "invoice_payments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refunded_by_fkey" FOREIGN KEY ("refunded_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_rawIngestEventId_fkey" FOREIGN KEY ("rawIngestEventId") REFERENCES "raw_ingest_events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "matters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_glCodeId_fkey" FOREIGN KEY ("glCodeId") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_change_logs" ADD CONSTRAINT "subscription_change_logs_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_change_logs" ADD CONSTRAINT "subscription_change_logs_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "pricing_plans"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_current_organization_id_fkey" FOREIGN KEY ("current_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_session" ADD CONSTRAINT "ba_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_account" ADD CONSTRAINT "ba_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_member" ADD CONSTRAINT "ba_member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_member" ADD CONSTRAINT "ba_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_invitation" ADD CONSTRAINT "ba_invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ba_invitation" ADD CONSTRAINT "ba_invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_services" ADD CONSTRAINT "signal_services_servicePricingId_fkey" FOREIGN KEY ("servicePricingId") REFERENCES "service_pricing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_services" ADD CONSTRAINT "signal_services_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_event_services" ADD CONSTRAINT "signal_event_services_signalEventId_fkey" FOREIGN KEY ("signalEventId") REFERENCES "signal_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_event_services" ADD CONSTRAINT "signal_event_services_servicePricingId_fkey" FOREIGN KEY ("servicePricingId") REFERENCES "service_pricing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_model_mappings" ADD CONSTRAINT "org_model_mappings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_model_mappings" ADD CONSTRAINT "org_model_mappings_targetPricingId_fkey" FOREIGN KEY ("targetPricingId") REFERENCES "service_pricing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_classification_rules" ADD CONSTRAINT "signal_classification_rules_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_classification_rules" ADD CONSTRAINT "signal_classification_rules_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_classification_overrides" ADD CONSTRAINT "signal_classification_overrides_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_classification_overrides" ADD CONSTRAINT "signal_classification_overrides_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_period_locks" ADD CONSTRAINT "finance_period_locks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_period_lock_events" ADD CONSTRAINT "finance_period_lock_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_dashboard_layouts" ADD CONSTRAINT "user_dashboard_layouts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_saved_views" ADD CONSTRAINT "user_saved_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_saved_views" ADD CONSTRAINT "user_saved_views_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "matters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initiative_targets" ADD CONSTRAINT "initiative_targets_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "initiatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cap_policies" ADD CONSTRAINT "cap_policies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cap_policy_events" ADD CONSTRAINT "cap_policy_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cap_alert_events" ADD CONSTRAINT "cap_alert_events_capPolicyId_fkey" FOREIGN KEY ("capPolicyId") REFERENCES "cap_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "credit_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pool_balances" ADD CONSTRAINT "credit_pool_balances_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_alert_events" ADD CONSTRAINT "pool_alert_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_alert_events" ADD CONSTRAINT "pool_alert_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_alerts" ADD CONSTRAINT "customer_alerts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_alerts" ADD CONSTRAINT "customer_alerts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_alert_events" ADD CONSTRAINT "customer_alert_events_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "customer_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_alert_notifications" ADD CONSTRAINT "customer_alert_notifications_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "customer_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matters" ADD CONSTRAINT "matters_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matter_routing_rules" ADD CONSTRAINT "matter_routing_rules_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matter_routing_rules" ADD CONSTRAINT "matter_routing_rules_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "matters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not expressible in schema.prisma: a partial index. Most usage rows carry no
-- matter, so indexing only the attributed ones keeps per-matter reads small.
CREATE INDEX "idx_signal_events_matter_attributed" ON "signal_events"("matterId") WHERE "matterId" IS NOT NULL;

-- Reference row: the price-list entry that prices a finished work item at $0.
-- The provider word 'outcome' is what marks a usage record as finished work.
-- The pricing seed and sync keep this row; ON CONFLICT makes a re-run safe.
INSERT INTO "service_pricing" (
  "id", "externalId", "displayName", "provider", "serviceType",
  "inputCost", "outputCost", "costUnit", "source", "isApi", "isActive",
  "canonicalName", "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid(), 'outcome/work-item', 'Finished work item', 'outcome',
  'Finished work', 0, NULL, 'item', 'builtin', true, true,
  'work-item', now(), now()
)
ON CONFLICT ("externalId") DO UPDATE SET
  "isActive" = true,
  "inputCost" = 0,
  "updatedAt" = now();
