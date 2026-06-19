import { NextResponse } from "next/server";
import {
  UpiQrUnavailableError,
  extractUpiQrFromCredential,
  hasRecognizedSessionCredential,
} from "@/lib/chatgpt-upi";

export const runtime = "nodejs";
export const maxDuration = 300;

const FALLBACK_QR_TTL_MS = 5 * 60 * 1000;

function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, message, details }, { status });
}

function compactError(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? String((error as { cause?: unknown }).cause || "") : "";
  const text = error instanceof Error ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause}` : ""}` : String(error);
  return text
    .replace(/(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?!\.[A-Za-z0-9_-])/g, "<JWT_REDACTED>")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, "<SESSION_TOKEN_REDACTED>")
    .replace(/(:\/\/[^:@/]+):([^@/]+)@/g, "$1:<PASSWORD_REDACTED>@")
    .slice(0, 700);
}

function normalizeExpiresAt(expiresAt?: number) {
  const expiresMs = Number(expiresAt || 0) * 1000;
  if (Number.isFinite(expiresMs) && expiresMs > Date.now() + 15_000) {
    return new Date(expiresMs);
  }
  return new Date(Date.now() + FALLBACK_QR_TTL_MS);
}

function chatGptPaymentUrl(processorEntity: string, checkoutSessionId: string) {
  return `https://chatgpt.com/checkout/${encodeURIComponent(processorEntity)}/${encodeURIComponent(checkoutSessionId)}`;
}

function qrPngDataUrl(buffer: Buffer | Uint8Array) {
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const credential = String(body.sessionToken || body.credential || "").trim();
    if (!credential) return fail("Please enter session token / cookie / session JSON.");
    if (!hasRecognizedSessionCredential(credential)) {
      return fail("No valid session token / session cookie / session JSON detected.", 400);
    }

    const maxProxyAttempts = Number(process.env.MAX_PROXY_ATTEMPTS || 0) || undefined;
    const extracted = await extractUpiQrFromCredential(credential, { maxProxyAttempts });
    const expiresAt = normalizeExpiresAt(extracted.expiresAt);

    return ok({
      qrImageUrl: qrPngDataUrl(extracted.qrPngBuffer),
      upiUri: extracted.upiUri,
      checkoutSessionId: extracted.checkoutSessionId,
      processorEntity: extracted.processorEntity,
      paymentUrl: chatGptPaymentUrl(extracted.processorEntity, extracted.checkoutSessionId),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof UpiQrUnavailableError) {
      return fail(compactError(error), 502);
    }
    return fail(compactError(error), 500);
  }
}
