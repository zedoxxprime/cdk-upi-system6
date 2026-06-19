import QRCode from "qrcode";
import { randomUUID } from "crypto";
import { describeUpstreamProxy, fetchWithUpstreamProxy, getUpstreamProxyPlan } from "@/lib/upstream-proxy";

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const ACCOUNT_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const ACCOUNT_CHECK_TIMEZONE_OFFSET_MIN = "-480";
const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const CHECKOUT_CONFIRM_URL = "https://chatgpt.com/backend-api/payments/checkout/confirm";
const CHECKOUT_APPROVE_URL = "https://chatgpt.com/backend-api/payments/checkout/approve";
const STRIPE_PAYMENT_PAGE_INIT_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}/init";
const STRIPE_PAYMENT_PAGE_CONFIRM_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}/confirm";
const STRIPE_PAYMENT_PAGE_GET_URL = "https://api.stripe.com/v1/payment_pages/{checkout_session_id}";
const STRIPE_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
const REQUEST_TIMEOUT_MS = 30_000;

const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

const ACCESS_TOKEN_RE = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?!\.[A-Za-z0-9_-])/;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

type JsonObject = Record<string, unknown>;

type ResolvedCredential = {
  accessToken: string;
  sessionData: JsonObject | null;
};

type UpiQrData = {
  upiUri?: string;
  mobileAuthUrl?: string;
  hostedInstructionsUrl?: string;
  qrImageUrlSvg?: string;
  qrImageUrlPng?: string;
  expiresAt?: number;
};

export type ExtractedUpiQr = {
  checkoutSessionId: string;
  publishableKey: string;
  processorEntity: string;
  upiUri: string;
  expiresAt: number;
  qrPngBuffer: Buffer;
  steps: Array<{ name: string; status: number; state?: unknown; result?: unknown; attemptStatuses?: number[] }>;
};

export type UpiExtractionStage =
  | "queued"
  | "validating"
  | "checkout"
  | "stripe_init"
  | "stripe_confirm"
  | "approval"
  | "waiting_qr"
  | "hydrating"
  | "rendering_qr"
  | "completed"
  | "retrying";

export type UpiExtractionProgress = {
  stage: UpiExtractionStage;
  percent: number;
  proxy?: string;
  attempt?: number;
  maxAttempts?: number;
};

type UpiExtractionOptions = {
  maxProxyAttempts?: number;
  onProgress?: (progress: UpiExtractionProgress) => void;
};

export type ChatGptSubscriptionCheck = {
  planType: string;
  isPlus: boolean;
  checkedAt: string;
  proxy: string;
};

export class UpiQrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpiQrUnavailableError";
  }
}

export class BillingCountryLockedError extends Error {
  constructor() {
    super("Account region locked by OpenAI – cannot change billing address.");
    this.name = "BillingCountryLockedError";
  }
}

function jsonLoadsMaybe(value: unknown) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || !"{[".includes(text[0])) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(obj: JsonObject | null | undefined, key: string) {
  const value = obj?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function jsonGetAccessToken(value: unknown) {
  const obj = jsonLoadsMaybe(value);
  if (!isObject(obj)) return "";

  for (const key of ["accessToken", "access_token", "token"]) {
    const token = getString(obj, key);
    if (token) return token;
  }

  const data = obj.data;
  if (isObject(data)) {
    for (const key of ["accessToken", "access_token", "token"]) {
      const token = getString(data, key);
      if (token) return token;
    }
  }

  return "";
}

function extractAccessToken(value: unknown) {
  const text = String(value || "").trim();
  const jsonToken = jsonGetAccessToken(value);
  if (jsonToken) return jsonToken;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text;
  return ACCESS_TOKEN_RE.exec(text)?.[0] || "";
}

function sessionCookieHeader(sessionToken: string) {
  const token = sessionToken.trim();
  if (!token) return "";
  return SESSION_COOKIE_NAMES.slice(0, 2).map((name) => `${name}=${token}`).join("; ");
}

function extractCookiePairsFromJson(value: unknown): Array<[string, string]> {
  const obj = jsonLoadsMaybe(value);
  if (!obj) return [] as Array<[string, string]>;

  if (isObject(obj)) {
    const sessionToken = getString(obj, "sessionToken") || getString(obj, "session_token");
    if (sessionToken) return [[SESSION_COOKIE_NAMES[0], sessionToken], [SESSION_COOKIE_NAMES[1], sessionToken]];
  }

  const cookies = Array.isArray(obj)
    ? obj
    : isObject(obj) && Array.isArray(obj.cookies)
      ? obj.cookies
      : [];

  const pairs: Array<[string, string]> = [];
  for (const item of cookies) {
    if (!isObject(item)) continue;
    const name = getString(item, "name");
    const cookieValue = getString(item, "value");
    if (name && cookieValue) pairs.push([name, cookieValue]);
  }
  return pairs;
}

function extractCookiePairsFromText(value: unknown): Array<[string, string]> {
  let text = String(value || "").trim();
  if (!text) return [] as Array<[string, string]>;
  if (text.toLowerCase().startsWith("cookie:")) text = text.split(":", 2)[1]?.trim() || "";

  const pairs: Array<[string, string]> = [];
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const cookieValue = trimmed.slice(eq + 1).trim();
    if (name && cookieValue) pairs.push([name, cookieValue]);
  }
  return pairs;
}

function withSessionCookieAliases(pairs: Array<[string, string]>): Array<[string, string]> {
  const nextPairs = pairs.filter(([name, value]) => Boolean(name && value));
  const existing = new Set(nextPairs.map(([name]) => name));
  const sessionValue = nextPairs.find(([name]) => SESSION_COOKIE_NAMES.includes(name as (typeof SESSION_COOKIE_NAMES)[number]))?.[1] || "";
  if (sessionValue) {
    for (const name of SESSION_COOKIE_NAMES.slice(0, 2)) {
      if (!existing.has(name)) nextPairs.push([name, sessionValue]);
    }
  }
  return nextPairs;
}

function extractSessionCookie(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";

  const pairs = extractCookiePairsFromJson(value);
  const textPairs = pairs.length ? pairs : extractCookiePairsFromText(value);
  if (textPairs.length && textPairs.some(([name]) => SESSION_COOKIE_NAMES.includes(name as (typeof SESSION_COOKIE_NAMES)[number]))) {
    return withSessionCookieAliases(textPairs).map(([name, cookieValue]) => `${name}=${cookieValue}`).join("; ");
  }

  if (SESSION_TOKEN_RE.test(text)) return sessionCookieHeader(text);
  return "";
}

export function hasRecognizedSessionCredential(value: unknown) {
  return Boolean(extractAccessToken(value) || extractSessionCookie(value));
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as JsonObject;
  } catch {
    return null;
  }
}

function getNestedString(obj: unknown, path: string[]) {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current.trim() : "";
}

function getSubscriptionPlanType(sessionData: JsonObject | null) {
  return (
    getNestedString(sessionData, ["account", "planType"]) ||
    getNestedString(sessionData, ["account", "plan_type"]) ||
    getNestedString(sessionData, ["account", "plan"]) ||
    getNestedString(sessionData, ["account", "subscription", "planType"]) ||
    getNestedString(sessionData, ["account", "subscription", "plan_type"]) ||
    getNestedString(sessionData, ["planType"]) ||
    getNestedString(sessionData, ["plan_type"]) ||
    ""
  ).trim();
}

function normalizePlanValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlusPlanValue(value: unknown) {
  const plan = normalizePlanValue(value);
  return plan === "plus" || plan === "chatgptplusplan" || (plan.includes("plus") && !plan.includes("free"));
}

function getAccountCheckUrl() {
  const url = new URL(ACCOUNT_CHECK_URL);
  url.searchParams.set("timezone_offset_min", process.env.CHATGPT_TIMEZONE_OFFSET_MIN || ACCOUNT_CHECK_TIMEZONE_OFFSET_MIN);
  return url.toString();
}

function accountCheckHeaders(token: string, cookie = "") {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "OAI-Language": "zh-CN",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function collectAccountCheckCandidates(data: unknown) {
  const candidates: unknown[] = [];
  const accounts = isObject(data) && isObject(data.accounts) ? data.accounts : null;
  if (!accounts) return isObject(data) ? [data] : candidates;

  if (accounts.default) candidates.push(accounts.default);
  for (const [key, value] of Object.entries(accounts)) {
    if (key !== "default") candidates.push(value);
  }
  return candidates;
}

function getAccountCheckSubscriptionStatus(data: unknown) {
  const plans: string[] = [];
  let hasActivePlusSubscription = false;

  for (const candidate of collectAccountCheckCandidates(data)) {
    const account = isObject(candidate) && isObject(candidate.account) ? candidate.account : candidate;
    const entitlement = isObject(candidate) && isObject(candidate.entitlement) ? candidate.entitlement : null;

    for (const value of [
      isObject(account) ? account.plan_type : undefined,
      isObject(account) ? account.planType : undefined,
      isObject(account) ? account.plan : undefined,
      getNestedString(account, ["subscription", "plan_type"]),
      getNestedString(account, ["subscription", "planType"]),
    ]) {
      const plan = normalizePlanValue(value);
      if (plan) plans.push(plan);
    }

    const subscriptionPlan = normalizePlanValue(entitlement?.subscription_plan);
    if (subscriptionPlan) plans.push(subscriptionPlan);
    if (entitlement?.has_active_subscription === true && isPlusPlanValue(subscriptionPlan)) {
      hasActivePlusSubscription = true;
    }
  }

  const plusPlan = plans.find(isPlusPlanValue);
  return {
    planType: plusPlan || plans[0] || "unknown",
    isPlus: Boolean(plusPlan || hasActivePlusSubscription),
  };
}

function requestHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function sessionHeaders(cookie: string) {
  return {
    Accept: "application/json",
    Cookie: cookie,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function stripeInitForm(publishableKey: string, locale = "en", initMode: "custom" | "hosted" = "custom") {
  if (initMode === "hosted") {
    return new URLSearchParams({
      key: publishableKey,
      eid: "NA",
      browser_locale: locale,
      browser_timezone: "Asia/Shanghai",
      redirect_type: "url",
    });
  }

  return new URLSearchParams({
    browser_locale: locale,
    browser_timezone: "Asia/Shanghai",
    "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
    "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
    "elements_session_client[elements_init_source]": "custom_checkout",
    "elements_session_client[referrer_host]": "chatgpt.com",
    "elements_session_client[stripe_js_id]": randomUUID().replace(/-/g, ""),
    "elements_session_client[locale]": locale,
    "elements_session_client[is_aggregation_expected]": "false",
    "elements_options_client[saved_payment_method][enable_save]": "auto",
    "elements_options_client[saved_payment_method][enable_redisplay]": "auto",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });
}

function stripeInitHeaders(initMode: "custom" | "hosted" = "custom", checkoutSessionId = "") {
  if (initMode === "hosted") {
    return {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://pay.openai.com",
      Referer: checkoutSessionId ? `https://pay.openai.com/c/pay/${encodeURIComponent(checkoutSessionId)}` : "https://pay.openai.com/",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };
  }
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://js.stripe.com",
    Referer: "https://js.stripe.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function stripeConfirmHeaders(checkoutSessionId = "") {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://js.stripe.com",
    Referer: checkoutSessionId ? `https://js.stripe.com/v3/elements-inner-payment-${encodeURIComponent(checkoutSessionId)}.html` : "https://js.stripe.com/",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function checkoutActionHeaders(token: string, checkoutSessionId: string, processorEntity: string) {
  return {
    ...requestHeaders(token),
    Referer: `https://chatgpt.com/checkout/${processorEntity}/${checkoutSessionId}`,
    "X-OpenAI-Target-Path": `/checkout/${processorEntity}/${checkoutSessionId}`,
    "X-OpenAI-Target-Route": "/checkout/[processorEntity]/[checkoutSessionId]",
    "OAI-Language": "zh-CN",
    "OAI-Chat-Web-Route": "/checkout/[processorEntity]/[checkoutSessionId]",
  };
}

function looksLikeCloudflareChallenge(text: string) {
  const lowered = text.toLowerCase();
  return lowered.includes("_cf_chl_opt") || lowered.includes("enable javascript and cookies to continue") || lowered.includes("cf-chl");
}

function compactError(data: unknown) {
  const value = isObject(data)
    ? data.error || data.message || data.detail || data
    : data;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(ACCESS_TOKEN_RE, "<JWT_REDACTED>")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .slice(0, 500);
}

async function fetchText(url: string, init: RequestInit = {}, proxyUrl = "") {
  const response = await fetchWithUpstreamProxy(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  }, proxyUrl);
  const text = await response.text();
  if (looksLikeCloudflareChallenge(text)) {
    return {
      status: 502,
      data: { error: "Request blocked by Cloudflare – please retry or change proxy." },
      response,
    };
  }
  try {
    return { status: response.status, data: JSON.parse(text || "{}") as unknown, response };
  } catch {
    return { status: response.status, data: { error: text.slice(0, 2000) || "Response is not JSON" }, response };
  }
}

async function resolveCredential(credential: string, proxyUrl = ""): Promise<ResolvedCredential> {
  const accessToken = extractAccessToken(credential);
  const obj = jsonLoadsMaybe(credential);
  const jsonSessionData = isObject(obj) ? obj : null;
  if (accessToken) {
    return { accessToken, sessionData: jsonSessionData };
  }

  const cookie = extractSessionCookie(credential);
  if (!cookie) {
    throw new Error("No valid session token / session cookie / session JSON detected.");
  }

  const { status, data } = await fetchText(SESSION_URL, {
    method: "GET",
    headers: sessionHeaders(cookie),
  }, proxyUrl);
  if (status >= 400 || !isObject(data)) {
    throw new Error(`Failed to exchange session token for accessToken (HTTP ${status}): ${compactError(data)}`);
  }

  const token = jsonGetAccessToken(data);
  if (!token) {
    throw new Error(`Session response missing accessToken: ${compactError(data)}`);
  }

  return { accessToken: token, sessionData: data };
}

async function resolveFreshSessionCredential(credential: string, proxyUrl = ""): Promise<ResolvedCredential> {
  const cookie = extractSessionCookie(credential);
  if (!cookie) return resolveCredential(credential, proxyUrl);

  const { status, data } = await fetchText(SESSION_URL, {
    method: "GET",
    headers: sessionHeaders(cookie),
  }, proxyUrl);
  if (status >= 400 || !isObject(data)) {
    throw new Error(`Failed to refresh session status (HTTP ${status}): ${compactError(data)}`);
  }

  const token = jsonGetAccessToken(data) || extractAccessToken(credential);
  return { accessToken: token, sessionData: data };
}

export async function validateCredentialForUpiExtraction(credential: string) {
  const attempts = await getProxyAttempts();
  const errors: string[] = [];
  let firstError: unknown = null;

  for (const attempt of attempts) {
    try {
      await resolveCredential(credential, attempt.proxyUrl);
      return { ok: true as const };
    } catch (error) {
      if (!firstError) firstError = error;
      if (isNonRetryableCredentialError(error) || attempts.length === 1) throw error;
      errors.push(`${attempt.label}: ${compactThrownError(error)}`);
      console.warn("UPI credential validation failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: compactThrownError(error),
      });
    }
  }

  if (firstError && errors.length === 0) throw firstError;
  throw new Error(`Session token validation failed after ${attempts.length} proxies: ${errors.join(" | ")}`);
}

async function callAccountCheck(accessToken: string, cookie: string, proxyUrl: string) {
  return fetchText(getAccountCheckUrl(), {
    method: "GET",
    headers: accountCheckHeaders(accessToken, cookie),
  }, proxyUrl);
}

export async function checkChatGptSubscription(credential: string): Promise<ChatGptSubscriptionCheck> {
  const attempts = await getProxyAttempts();
  const errors: string[] = [];
  let firstError: unknown = null;
  const cookie = extractSessionCookie(credential);

  for (const attempt of attempts) {
    try {
      const { accessToken, sessionData } = await resolveFreshSessionCredential(credential, attempt.proxyUrl);
      const accountCheck = await callAccountCheck(accessToken, cookie, attempt.proxyUrl);
      if (accountCheck.status >= 400 || !isObject(accountCheck.data)) {
        throw new Error(`accounts/check subscription check failed (HTTP ${accountCheck.status}): ${compactError(accountCheck.data)}`);
      }

      const accountStatus = getAccountCheckSubscriptionStatus(accountCheck.data);
      if (accountStatus.isPlus || accountStatus.planType !== "unknown") {
        return {
          planType: accountStatus.planType,
          isPlus: accountStatus.isPlus,
          checkedAt: new Date().toISOString(),
          proxy: attempt.label,
        };
      }

      const planType = getSubscriptionPlanType(sessionData);
      return {
        planType: planType || "unknown",
        isPlus: isPlusPlanValue(planType),
        checkedAt: new Date().toISOString(),
        proxy: attempt.label,
      };
    } catch (error) {
      if (!firstError) firstError = error;
      if (isNonRetryableCredentialError(error) || attempts.length === 1) throw error;
      const message = compactThrownError(error);
      errors.push(`${attempt.label}: ${message}`);
      console.warn("ChatGPT subscription check failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: message,
      });
    }
  }

  if (firstError && errors.length === 0) throw firstError;
  throw new Error(`Subscription check failed after ${attempts.length} proxies: ${errors.join(" | ")}`);
}

function checkoutPayload() {
  return {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: {
      country: "IN",
      currency: "INR",
    },
    checkout_ui_mode: "custom",
    cancel_url: "https://chatgpt.com/#pricing",
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false,
    },
  };
}

async function callCheckout(accessToken: string, proxyUrl: string) {
  return fetchText(CHECKOUT_URL, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify(checkoutPayload()),
  }, proxyUrl);
}

async function callStripeInit(checkoutSessionId: string, publishableKey: string, proxyUrl: string) {
  const url = STRIPE_PAYMENT_PAGE_INIT_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  return fetchText(url, {
    method: "POST",
    headers: stripeInitHeaders("custom", checkoutSessionId),
    body: stripeInitForm(publishableKey, "en", "custom").toString(),
  }, proxyUrl);
}

function amountMinor(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (isObject(value)) {
    for (const key of ["amount", "amount_due", "minor", "value"]) {
      const next = amountMinor(value[key]);
      if (next != null) return next;
    }
  }
  return null;
}

function nestedGet(data: unknown, path: string[]) {
  let current = data;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function extractPaymentAmount(initData: unknown) {
  return (
    amountMinor(nestedGet(initData, ["total_summary", "due"])) ??
    amountMinor(nestedGet(initData, ["invoice", "amount_due"])) ??
    amountMinor(nestedGet(initData, ["elements_options", "amount"])) ??
    0
  );
}

function stripeConfirmForm(initData: unknown, publishableKey: string) {
  const params = new URLSearchParams({
    "payment_method_data[billing_details][name]": "Rahul Sharma",
    "payment_method_data[billing_details][email]": "upi-extractor@example.com",
    "payment_method_data[billing_details][address][line1]": "Flat 302, Sai Residency",
    "payment_method_data[billing_details][address][line2]": "MG Road, Andheri East",
    "payment_method_data[billing_details][address][city]": "Mumbai",
    "payment_method_data[billing_details][address][state]": "Maharashtra",
    "payment_method_data[billing_details][address][postal_code]": "400069",
    "payment_method_data[billing_details][address][country]": "IN",
    "payment_method_data[type]": "upi",
    expected_amount: String(extractPaymentAmount(initData)),
    expected_payment_method_type: "upi",
    key: publishableKey,
    _stripe_version: STRIPE_VERSION,
  });

  const initChecksum = isObject(initData) ? initData.init_checksum : undefined;
  if (initChecksum) params.set("init_checksum", String(initChecksum));
  return params;
}

function unknownParameter(data: unknown) {
  const error = isObject(data) && isObject(data.error) ? data.error : data;
  if (!isObject(error) || String(error.code || "") !== "parameter_unknown") return "";
  return typeof error.param === "string" ? error.param.trim() : "";
}

async function callStripeConfirm(checkoutSessionId: string, publishableKey: string, initData: unknown, proxyUrl: string) {
  const url = STRIPE_PAYMENT_PAGE_CONFIRM_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const form = stripeConfirmForm(initData, publishableKey);
  let result = await fetchText(url, {
    method: "POST",
    headers: stripeConfirmHeaders(checkoutSessionId),
    body: form.toString(),
  }, proxyUrl);

  const unknown = unknownParameter(result.data);
  if (result.status >= 400 && unknown && form.has(unknown)) {
    form.delete(unknown);
    result = await fetchText(url, {
      method: "POST",
      headers: stripeConfirmHeaders(checkoutSessionId),
      body: form.toString(),
    }, proxyUrl);
  }

  return result;
}

async function callChatGptCheckoutApproval(accessToken: string, checkoutSessionId: string, processorEntity: string, proxyUrl: string) {
  const endpoints = [
    {
      url: CHECKOUT_CONFIRM_URL,
      payload: { checkout_session_id: checkoutSessionId, selected_payment_method_type: "upi" },
      name: "confirm",
    },
    {
      url: CHECKOUT_APPROVE_URL,
      payload: { checkout_session_id: checkoutSessionId, processor_entity: processorEntity },
      name: "approve",
    },
  ] as const;

  let last: { status: number; data: unknown; name: string } = { status: 0, data: {}, name: "" };
  for (const endpoint of endpoints) {
    const result = await fetchText(endpoint.url, {
      method: "POST",
      headers: checkoutActionHeaders(accessToken, checkoutSessionId, processorEntity),
      body: JSON.stringify(endpoint.payload),
    }, proxyUrl);
    last = { status: result.status, data: result.data, name: endpoint.name };
    const resultText = isObject(result.data) ? String(result.data.result || "").toLowerCase() : "";
    if (result.status < 400 && !["blocked", "exception"].includes(resultText)) return last;
  }
  return last;
}

async function callStripePaymentPageGet(checkoutSessionId: string, publishableKey: string, proxyUrl: string) {
  const base = STRIPE_PAYMENT_PAGE_GET_URL.replace("{checkout_session_id}", encodeURIComponent(checkoutSessionId));
  const url = `${base}?${new URLSearchParams({ key: publishableKey, _stripe_version: STRIPE_VERSION }).toString()}`;
  return fetchText(url, {
    method: "GET",
    headers: stripeConfirmHeaders(checkoutSessionId),
  }, proxyUrl);
}

function mergeUpiKey(result: UpiQrData, key: string, value: unknown) {
  if (value == null) return;
  const normalizedKey = key.toLowerCase();
  if (typeof value === "string") {
    if (value.startsWith("upi://") && !result.upiUri) {
      result.upiUri = value;
      result.mobileAuthUrl = value;
    } else if (value.startsWith("https://payments.stripe.com/upi/instructions/") && !result.hostedInstructionsUrl) {
      result.hostedInstructionsUrl = value;
    } else if (value.startsWith("https://qr.stripe.com/") && value.toLowerCase().includes("svg") && !result.qrImageUrlSvg) {
      result.qrImageUrlSvg = value;
    } else if (value.startsWith("https://qr.stripe.com/") && value.toLowerCase().includes("png") && !result.qrImageUrlPng) {
      result.qrImageUrlPng = value;
    }
  }

  if (["hosted_instructions_url", "mobile_auth_url", "upi_uri", "image_url_svg", "qr_image_url_svg", "image_url_png", "qr_image_url_png"].includes(normalizedKey) && typeof value === "string" && value) {
    const outKey: keyof UpiQrData =
      normalizedKey === "image_url_svg" || normalizedKey === "qr_image_url_svg"
        ? "qrImageUrlSvg"
        : normalizedKey === "image_url_png" || normalizedKey === "qr_image_url_png"
          ? "qrImageUrlPng"
          : normalizedKey === "hosted_instructions_url"
            ? "hostedInstructionsUrl"
            : normalizedKey === "mobile_auth_url"
              ? "mobileAuthUrl"
              : "upiUri";
    result[outKey] ||= value;
  }

  if (["expires_at", "expires_after_timestamp", "qr_expires_at"].includes(normalizedKey)) {
    const expiresAt = Number(value);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && !result.expiresAt) result.expiresAt = Math.floor(expiresAt);
  }
}

function extractUpiNextAction(data: unknown) {
  const result: UpiQrData = {};
  const walk = (value: unknown, key = "") => {
    mergeUpiKey(result, key, value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "qr_code" && isObject(childValue)) {
        mergeUpiKey(result, "qr_expires_at", childValue.expires_at);
        mergeUpiKey(result, "image_url_svg", childValue.image_url_svg);
        mergeUpiKey(result, "image_url_png", childValue.image_url_png);
      }
      walk(childValue, childKey);
    }
  };
  walk(data);
  return result;
}

function decodePayloadB64(value: string) {
  const text = value.replace(/&quot;/g, "\"").replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, "="), "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function extractUpiQrFromHostedHtml(pageHtml: string) {
  const result: UpiQrData = {};
  const meta = /<meta\b(?=[^>]*\bid=["']payload["'])(?=[^>]*\bdata-message=["']([^"']+)["'])[^>]*>/i.exec(pageHtml);
  if (meta?.[1]) {
    const payload = decodePayloadB64(meta[1]);
    if (isObject(payload)) {
      mergeUpiKey(result, "mobile_auth_url", payload.mobile_auth_url);
      mergeUpiKey(result, "upi_uri", payload.upi_uri);
      mergeUpiKey(result, "expires_at", payload.expires_at || payload.expires_after_timestamp);
    }
  }

  const imgMatches = pageHtml.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
  for (const match of imgMatches) {
    const src = match[1]?.replace(/&amp;/g, "&") || "";
    const tag = match[0] || "";
    if (src.includes("qr.stripe.com") || tag.includes("QRCode-image")) {
      mergeUpiKey(result, src.toLowerCase().includes("png") ? "qr_image_url_png" : "qr_image_url_svg", src);
      break;
    }
  }
  return result;
}

async function hydrateUpiQrData(qrData: UpiQrData, proxyUrl: string) {
  const next = { ...qrData };
  if (next.hostedInstructionsUrl && !next.upiUri) {
    const response = await fetchWithUpstreamProxy(next.hostedInstructionsUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://js.stripe.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    }, proxyUrl);
    if (response.ok) {
      const extracted = extractUpiQrFromHostedHtml(await response.text());
      Object.assign(next, Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)));
    }
  }
  return next;
}

async function makeUpiQrPng(upiUri: string) {
  if (!upiUri.toLowerCase().startsWith("upi://")) {
    throw new Error("Extracted data is not upi:// protocol – cannot generate UPI QR.");
  }
  return QRCode.toBuffer(upiUri, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 12,
  });
}

type ProxyAttempt = {
  proxyUrl: string;
  label: string;
};

async function getProxyAttempts(): Promise<ProxyAttempt[]> {
  const plan = await getUpstreamProxyPlan();
  if (plan.length === 0) return [{ proxyUrl: "", label: "DIRECT" }];
  return plan.map((proxy) => ({
    proxyUrl: proxy.url,
    label: `#${proxy.index + 1} ${describeUpstreamProxy(proxy.url)}`,
  }));
}

function compactThrownError(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause}` : ""}` : String(error);
  return text
    .replace(ACCESS_TOKEN_RE, "<JWT_REDACTED>")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@")
    .slice(0, 700);
}

function isNonRetryableCredentialError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No valid session token") ||
    message.includes("Session response missing accessToken") ||
    /Failed to refresh session status \(HTTP (401|403)/.test(message) ||
    /Failed to exchange session token for accessToken \(HTTP (401|403)/.test(message)
  );
}

function isBillingCountryLockedErrorMessage(message: string) {
  return message.toLowerCase().includes("billing country must match request country");
}

function reportExtractionProgress(options: UpiExtractionOptions | undefined, progress: UpiExtractionProgress) {
  try {
    options?.onProgress?.({
      ...progress,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  } catch {
    // Progress reporting must never break extraction.
  }
}

async function extractUpiQrFromCredentialWithProxy(
  credential: string,
  proxyUrl: string,
  options?: UpiExtractionOptions
): Promise<ExtractedUpiQr> {
  const proxyLabel = describeUpstreamProxy(proxyUrl);
  reportExtractionProgress(options, { stage: "validating", percent: 10, proxy: proxyLabel });
  const { accessToken, sessionData } = await resolveCredential(credential, proxyUrl);
  // No email blocking – any valid session works

  reportExtractionProgress(options, { stage: "checkout", percent: 24, proxy: proxyLabel });
  const checkout = await callCheckout(accessToken, proxyUrl);
  if (checkout.status >= 400 || !isObject(checkout.data) || checkout.data.error) {
    const checkoutError = compactError(checkout.data);
    if (isBillingCountryLockedErrorMessage(checkoutError)) throw new BillingCountryLockedError();
    throw new Error(`UPI checkout creation failed: ${checkoutError}`);
  }

  const checkoutSessionId = String(checkout.data.checkout_session_id || checkout.data.cs_id || "").trim();
  const publishableKey = String(checkout.data.publishable_key || "").trim();
  const processorEntity = String(checkout.data.processor_entity || "openai_llc").trim() || "openai_llc";
  if (!checkoutSessionId || !publishableKey) {
    throw new Error(`Checkout response missing required fields: ${compactError(checkout.data)}`);
  }

  const steps: ExtractedUpiQr["steps"] = [];
  reportExtractionProgress(options, { stage: "stripe_init", percent: 38, proxy: proxyLabel });
  const init = await callStripeInit(checkoutSessionId, publishableKey, proxyUrl);
  steps.push({ name: "stripe_init_custom", status: init.status });
  if (init.status >= 400 || !isObject(init.data) || init.data.error) {
    throw new Error(`Stripe custom init failed: ${compactError(init.data)}`);
  }

  const paymentMethods = nestedGet(init.data, ["elements_options", "payment_method_types"]) || init.data.payment_method_types || [];
  if (Array.isArray(paymentMethods) && paymentMethods.length > 0 && !paymentMethods.map((item) => String(item).toLowerCase()).includes("upi")) {
    throw new Error(`Checkout did not return UPI, available_payment_method_types=${paymentMethods.join(",")}`);
  }

  reportExtractionProgress(options, { stage: "stripe_confirm", percent: 52, proxy: proxyLabel });
  const confirm = await callStripeConfirm(checkoutSessionId, publishableKey, init.data, proxyUrl);
  steps.push({
    name: "stripe_confirm_upi",
    status: confirm.status,
    state: nestedGet(confirm.data, ["submission_attempt", "state"]),
  });
  if (confirm.status >= 400 || !isObject(confirm.data) || confirm.data.error) {
    throw new Error(`Stripe UPI confirm failed: ${compactError(confirm.data)}`);
  }

  reportExtractionProgress(options, { stage: "approval", percent: 66, proxy: proxyLabel });
  const approval = await callChatGptCheckoutApproval(accessToken, checkoutSessionId, processorEntity, proxyUrl);
  steps.push({
    name: `chatgpt_checkout_${approval.name || "approval"}`,
    status: approval.status,
    result: isObject(approval.data) ? approval.data.result : undefined,
  });

  let qrData: UpiQrData = {};
  for (const source of [confirm.data, approval.data]) {
    const extracted = extractUpiNextAction(source);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
  }

  const getStatuses: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (qrData.upiUri || qrData.hostedInstructionsUrl || qrData.qrImageUrlSvg || qrData.qrImageUrlPng) break;
    reportExtractionProgress(options, {
      stage: "waiting_qr",
      percent: 72 + Math.min(16, attempt),
      proxy: proxyLabel,
    });
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await callStripePaymentPageGet(checkoutSessionId, publishableKey, proxyUrl);
    getStatuses.push(page.status);
    const extracted = extractUpiNextAction(page.data);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
    if (page.status >= 400) break;
  }
  if (getStatuses.length) {
    steps.push({ name: "stripe_payment_page_get", status: getStatuses[getStatuses.length - 1], attemptStatuses: getStatuses });
  }

  if (!qrData.upiUri && !qrData.hostedInstructionsUrl && !qrData.qrImageUrlSvg && !qrData.qrImageUrlPng) {
    const refresh = await callStripeInit(checkoutSessionId, publishableKey, proxyUrl);
    steps.push({ name: "stripe_init_refresh", status: refresh.status });
    const extracted = extractUpiNextAction(refresh.data);
    qrData = { ...qrData, ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)) };
  }

  reportExtractionProgress(options, { stage: "hydrating", percent: 91, proxy: proxyLabel });
  qrData = await hydrateUpiQrData(qrData, proxyUrl);
  const upiUri = qrData.upiUri || qrData.mobileAuthUrl || "";
  if (!upiUri) {
    console.error("UPI extraction failed without upi uri", {
      steps,
      hasHostedInstructionsUrl: Boolean(qrData.hostedInstructionsUrl),
      hasQrImageUrlSvg: Boolean(qrData.qrImageUrlSvg),
      hasQrImageUrlPng: Boolean(qrData.qrImageUrlPng),
      approvalStatus: approval.status,
      approvalResult: isObject(approval.data) ? approval.data.result : undefined,
      proxy: proxyLabel,
    });
    const stepText = steps.map((step) => {
      const suffix = step.attemptStatuses?.length ? ` attempts=${step.attemptStatuses.join("/")}` : "";
      const state = step.state ? ` state=${String(step.state)}` : "";
      const result = step.result ? ` result=${String(step.result)}` : "";
      return `${step.name}:${step.status}${state}${result}${suffix}`;
    }).join(" -> ");
    let detail = `Failed to obtain upi:// data from protocol responses. Steps completed: ${stepText || "none"}.`;
    if (approval.status < 400 && isObject(approval.data) && String(approval.data.result || "").toLowerCase() === "approved") {
      detail += " ChatGPT returned approved, but Stripe did not return UPI QR fields – retry with different proxy or account.";
    }
    if (approval.status >= 400 || (isObject(approval.data) && ["blocked", "exception"].includes(String(approval.data.result || "").toLowerCase()))) {
      detail += ` ChatGPT approval returned error: HTTP ${approval.status} ${compactError(approval.data)}`;
    }
    throw new UpiQrUnavailableError(detail);
  }

  reportExtractionProgress(options, { stage: "rendering_qr", percent: 96, proxy: proxyLabel });
  const qrPngBuffer = await makeUpiQrPng(upiUri);
  reportExtractionProgress(options, { stage: "completed", percent: 100, proxy: proxyLabel });

  return {
    checkoutSessionId,
    publishableKey,
    processorEntity,
    upiUri,
    expiresAt: qrData.expiresAt || Math.floor(Date.now() / 1000) + 300,
    qrPngBuffer,
    steps,
  };
}

export async function extractUpiQrFromCredential(credential: string, options?: UpiExtractionOptions): Promise<ExtractedUpiQr> {
  const allAttempts = await getProxyAttempts();
  const maxProxyAttempts = Math.max(1, Math.floor(options?.maxProxyAttempts || allAttempts.length || 1));
  const attempts = allAttempts.slice(0, maxProxyAttempts);
  const errors: string[] = [];
  let firstError: unknown = null;

  reportExtractionProgress(options, { stage: "queued", percent: 4, maxAttempts: attempts.length });
  for (const attempt of attempts) {
    try {
      reportExtractionProgress(options, {
        stage: "validating",
        percent: 8,
        proxy: attempt.label,
        attempt: attempts.indexOf(attempt) + 1,
        maxAttempts: attempts.length,
      });
      return await extractUpiQrFromCredentialWithProxy(credential, attempt.proxyUrl, {
        ...options,
        onProgress: (progress) => {
          options?.onProgress?.({
            ...progress,
            proxy: attempt.label,
            attempt: attempts.indexOf(attempt) + 1,
            maxAttempts: attempts.length,
          });
        },
      });
    } catch (error) {
      if (!firstError) firstError = error;
      if (
        error instanceof BillingCountryLockedError ||
        isBillingCountryLockedErrorMessage(error instanceof Error ? error.message : String(error)) ||
        isNonRetryableCredentialError(error) ||
        attempts.length === 1
      ) throw error;
      const message = compactThrownError(error);
      errors.push(`${attempt.label}: ${message}`);
      reportExtractionProgress(options, {
        stage: "retrying",
        percent: 8,
        proxy: attempt.label,
        attempt: attempts.indexOf(attempt) + 1,
        maxAttempts: attempts.length,
      });
      console.warn("UPI extraction failed on proxy, trying next proxy", {
        proxy: attempt.label,
        error: message,
      });
    }
  }

  if (firstError && errors.length === 0) throw firstError;
  throw new Error(`UPI QR generation failed after ${attempts.length} proxies: ${errors.join(" | ")}`);
}
