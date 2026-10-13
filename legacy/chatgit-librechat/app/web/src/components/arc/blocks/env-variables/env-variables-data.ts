/** Sample data for the environment variables block. Secrets are fake and deterministic. */

export type EnvName = "development" | "preview" | "production";

export type EnvVariable = {
  /** Stable id. A key can appear on several rows when each row covers different environments. */
  id: string;
  key: string;
  value: string;
  /** Environments this value applies to. A key has at most one value per environment. */
  environments: EnvName[];
  /** Write-only: the value can be replaced but never read back. */
  sensitive: boolean;
  updated: string;
  updatedBy: string;
};

export const ENVIRONMENTS: { id: EnvName; label: string }[] = [
  { id: "development", label: "Development" },
  { id: "preview", label: "Preview" },
  { id: "production", label: "Production" },
];

export const PROJECT = { name: "northwind-storefront", branch: "main" };

export const VARIABLES: EnvVariable[] = [
  { id: "db-prod", key: "DATABASE_URL", value: "postgresql://storefront:Qm7vR2xKp9LwT4nZ@db-prod.northwind.internal:5432/storefront?sslmode=require", environments: ["production"], sensitive: true, updated: "Aug 12", updatedBy: "Emma Collins" },
  { id: "db-dev", key: "DATABASE_URL", value: "postgresql://storefront:preview@db-staging.northwind.internal:5432/storefront_preview", environments: ["development", "preview"], sensitive: false, updated: "Aug 12", updatedBy: "Emma Collins" },
  { id: "site-prod", key: "NEXT_PUBLIC_SITE_URL", value: "https://shop.northwind.co", environments: ["production"], sensitive: false, updated: "Jun 3", updatedBy: "Marcus Johnson" },
  { id: "site-preview", key: "NEXT_PUBLIC_SITE_URL", value: "https://preview.northwind.co", environments: ["preview"], sensitive: false, updated: "Jun 3", updatedBy: "Marcus Johnson" },
  { id: "site-dev", key: "NEXT_PUBLIC_SITE_URL", value: "http://localhost:3000", environments: ["development"], sensitive: false, updated: "Jun 3", updatedBy: "Marcus Johnson" },
  { id: "stripe-live", key: "STRIPE_SECRET_KEY", value: "sk_live_51Nw8QeHv2kR9tXa7LmPq4ZsY0bUcJ3dF", environments: ["production"], sensitive: true, updated: "Sep 2", updatedBy: "Ava Mitchell" },
  { id: "stripe-test", key: "STRIPE_SECRET_KEY", value: "sk_test_51Nw8QeHv2kR9tXa7Tg6Wn1KcE5pLr8yV", environments: ["development", "preview"], sensitive: false, updated: "Sep 2", updatedBy: "Ava Mitchell" },
  { id: "stripe-hook", key: "STRIPE_WEBHOOK_SECRET", value: "whsec_9f3KqL2vX8mN4pR7tY1wZ6cB5dH0jG", environments: ["production"], sensitive: true, updated: "Sep 2", updatedBy: "Ava Mitchell" },
  { id: "resend", key: "RESEND_API_KEY", value: "re_Hk4q9TzLm_8VbWcN2xPr5sJd7FgY3eA", environments: ["development", "preview", "production"], sensitive: false, updated: "Jul 19", updatedBy: "Jasmine Brooks" },
  { id: "sentry", key: "SENTRY_DSN", value: "https://4b7e21c9d0a34f86@o551204.ingest.sentry.io/6210398", environments: ["preview", "production"], sensitive: false, updated: "May 27", updatedBy: "Marcus Johnson" },
  { id: "redis-prod", key: "REDIS_URL", value: "rediss://default:Xt8pL3qW7nZ2@cache-prod.northwind.internal:6380", environments: ["production"], sensitive: true, updated: "Sep 18", updatedBy: "Sofia Ramirez" },
  { id: "redis-preview", key: "REDIS_URL", value: "redis://cache-staging.northwind.internal:6379", environments: ["preview"], sensitive: false, updated: "Sep 18", updatedBy: "Sofia Ramirez" },
  { id: "checkout-flag", key: "FEATURE_NEW_CHECKOUT", value: "true", environments: ["development", "preview"], sensitive: false, updated: "Sep 21", updatedBy: "Emma Collins" },
  { id: "checkout-flag-prod", key: "FEATURE_NEW_CHECKOUT", value: "false", environments: ["production"], sensitive: false, updated: "Sep 21", updatedBy: "Emma Collins" },
  { id: "log-dev", key: "LOG_LEVEL", value: "debug", environments: ["development"], sensitive: false, updated: "Apr 8", updatedBy: "Sofia Ramirez" },
  { id: "log", key: "LOG_LEVEL", value: "info", environments: ["preview", "production"], sensitive: false, updated: "Apr 8", updatedBy: "Sofia Ramirez" },
  { id: "search-admin", key: "SEARCH_ADMIN_KEY", value: "a1c9f4e27b8d6035e2f7a9b41c8d3e60", environments: ["production"], sensitive: true, updated: "Jul 30", updatedBy: "Jasmine Brooks" },
];

/** What the paste area starts with when someone opens Import .env. */
export const SAMPLE_DOTENV = `# Copied from .env.local
NEXT_PUBLIC_POSTHOG_KEY=phc_Rk2mT8vLq4xW9nZcB7pD1sF6hJ3yG5aE
SEARCH_ADMIN_KEY=b7e2a9c41d06f8e3a5c2b9d7e14f6a08
export SHIPPING_API_TOKEN="shippo_test_4e9c2b7a1f8d3e60c5b2"
LOG_LEVEL=warn
2FA_SECRET=JBSWY3DPEHPK3PXP
LOG_LEVEL=error`;
