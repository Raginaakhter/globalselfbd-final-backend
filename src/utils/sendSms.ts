// SMS integration seam. In production this talks to MoceanAPI (via SMS_PROVIDER_URL).
// In development, when no provider is configured, the message is logged to the console
// so flows can be tested without a real gateway. Credentials live in .env ONLY and
// must never reach the frontend bundle.
//
// Environment variables:
//   SMS_PROVIDER_URL  e.g. https://rest.moceanapi.com/rest/2/sms
//   SMS_API_KEY       Mocean API bearer token (shape: "apit-...")
//   SMS_API_SECRET    (optional) only used when the provider needs basic auth
//   SMS_SENDER_ID     "MOCEAN" or your approved alphanumeric sender ID
//
// To add a different provider: branch inside sendSmsViaProvider() on the host, keeping
// the return shape { sent, provider }.

export interface SmsMessage {
  to: string;      // E.164 or BD-local phone number (e.g. "01712345678")
  message: string; // plain text, 160-char segments
}

export const isSmsConfigured = (): boolean =>
  Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_API_KEY);

// Mocean accepts BD local numbers, but strict E.164 is safer. "01712345678" -> "8801712345678".
const toE164 = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("88")) return digits;
  if (digits.startsWith("0")) return `88${digits}`;
  return `88${digits}`;
};

const parseProviderResponse = async (
  response: Response,
  provider: string
): Promise<{ sent: boolean; provider: string; details?: unknown }> => {
  const raw = await response.text().catch(() => "");
  // Mocean replies with JSON like { "messages": [{ "status": 0 }] }; status 0 == success.
  // Mocean inconsistently serializes `status` as a number (success) or string (error),
  // so coerce before comparing.
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }

  if (!response.ok) {
    console.error(`❌ SMS send failed (${response.status}) via ${provider}:`, raw.slice(0, 500));
    return { sent: false, provider, details: parsed };
  }

  const isSuccess = (status: unknown): boolean => String(status) === "0";

  if (parsed && typeof parsed === "object") {
    const anyParsed = parsed as { messages?: Array<{ status?: unknown; err_msg?: string }>; status?: unknown };
    const first = anyParsed.messages?.[0];
    if (first && !isSuccess(first.status)) {
      console.error(`❌ SMS provider ${provider} rejected message:`, JSON.stringify(parsed).slice(0, 500));
      return { sent: false, provider, details: parsed };
    }
    if (anyParsed.status !== undefined && !isSuccess(anyParsed.status) && !anyParsed.messages) {
      console.error(`❌ SMS provider ${provider} rejected message:`, JSON.stringify(parsed).slice(0, 500));
      return { sent: false, provider, details: parsed };
    }
  }
  // Log the accepted response (msgid, receiver) so delivery can be traced on the
  // provider dashboard even when the SIM never receives it (carrier filter, blocked
  // sender ID, etc.). SMS text is not logged.
  console.log(`✅ SMS accepted by ${provider}:`, JSON.stringify(parsed).slice(0, 300));
  return { sent: true, provider, details: parsed };
};

const sendViaMocean = async (
  url: string,
  key: string,
  secret: string | undefined,
  sender: string,
  msg: SmsMessage
): Promise<{ sent: boolean; provider: string; details?: unknown }> => {
  const host = new URL(url).host;
  // Mocean's /rest/2/sms endpoint supports two auth modes:
  //   1. API Token (bearer, key starts with "apit-"): Authorization: Bearer <token>
  //   2. API key + API secret pair: both as form params (mocean-api-key, mocean-api-secret)
  // We prefer whichever matches the configured credentials.
  const isApiToken = key.startsWith("apit-");
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const params = new URLSearchParams({
    "mocean-from": sender,
    "mocean-to": toE164(msg.to),
    "mocean-text": msg.message,
    "mocean-resp-format": "JSON",
  });

  if (isApiToken) {
    headers.Authorization = `Bearer ${key}`;
  } else {
    if (!secret) {
      console.error(
        `❌ SMS (${host}): SMS_API_SECRET is not set. For a key+secret pair, Mocean /rest/2/sms ` +
          `needs BOTH SMS_API_KEY and SMS_API_SECRET. For an API Token login, SMS_API_KEY must ` +
          `start with "apit-" (bearer auth).`
      );
      return { sent: false, provider: host };
    }
    params.set("mocean-api-key", key);
    params.set("mocean-api-secret", secret);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
    return parseProviderResponse(response, host);
  } catch (error) {
    console.error(`❌ SMS send error (${host}):`, (error as Error).message);
    return { sent: false, provider: host };
  }
};

const sendViaGeneric = async (
  url: string,
  key: string,
  sender: string,
  msg: SmsMessage
): Promise<{ sent: boolean; provider: string; details?: unknown }> => {
  const host = new URL(url).host;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ to: toE164(msg.to), from: sender, message: msg.message }),
      signal: AbortSignal.timeout(15000),
    });
    return parseProviderResponse(response, host);
  } catch (error) {
    console.error(`❌ SMS send error (${host}):`, (error as Error).message);
    return { sent: false, provider: host };
  }
};

const sendSmsViaProvider = async (msg: SmsMessage): Promise<{ sent: boolean; provider: string }> => {
  const url = process.env.SMS_PROVIDER_URL;
  const key = process.env.SMS_API_KEY;
  const secret = process.env.SMS_API_SECRET;
  const sender = process.env.SMS_SENDER_ID || "GlobalShelfBD";
  if (!url || !key) return { sent: false, provider: "none" };

  const host = new URL(url).host.toLowerCase();
  const result = host.includes("moceanapi.com")
    ? await sendViaMocean(url, key, secret, sender, msg)
    : await sendViaGeneric(url, key, sender, msg);
  return { sent: result.sent, provider: result.provider };
};

export const sendSms = async (msg: SmsMessage): Promise<{ sent: boolean; provider: string }> => {
  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "development") {
      // Make the fallback impossible to miss: this is NOT a real SMS send.
      console.log(
        `⚠️  SMS NOT SENT (no provider configured). Add SMS_PROVIDER_URL, SMS_API_KEY and SMS_API_SECRET to .env.\n` +
          `   dev-console fallback → ${msg.to}: ${msg.message}`
      );
      return { sent: true, provider: "dev-console" };
    }
    console.error(`❌ SMS NOT SENT: no SMS provider configured (SMS_PROVIDER_URL / SMS_API_KEY missing)`);
    return { sent: false, provider: "none" };
  }
  return sendSmsViaProvider(msg);
};

// Backwards compatible: the password reset flow still uses this.
export const sendPasswordResetOtpSms = (
  user: { fullName: string; phoneNumber: string },
  otp: string,
  minutes: number
) =>
  sendSms({
    to: user.phoneNumber,
    message: `${otp} is your GlobalShelfBD code. It expires in ${minutes} minutes. Do not share this code.`,
  });

// New: single-use login/register OTP (same provider path, shorter wording).
export const sendLoginOtpSms = (phoneNumber: string, otp: string, minutes: number) =>
  sendSms({
    to: phoneNumber,
    message: `${otp} is your GlobalShelfBD login code. Expires in ${minutes} minutes. Do not share this code.`,
  });
