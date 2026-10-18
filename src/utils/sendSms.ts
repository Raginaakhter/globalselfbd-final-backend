// SMS integration seam. Talks to Zend SMS (https://api.zendsms.com).
// In development, when no API key is configured, the message is logged to the
// console so flows can be tested without a real gateway. Credentials live in
// .env ONLY and must never reach the frontend bundle.
//
// Environment variables:
//   SMS_PROVIDER_URL  (optional) override endpoint. Defaults to Zend's
//                     https://api.zendsms.com/api/v1/send-sms
//   SMS_API_KEY       Zend secret key (starts with "sk_"), sent as a Bearer token
//   SMS_SENDER_ID     An approved sender ID on your Zend SMS account

const ZEND_DEFAULT_URL = "https://api.zendsms.com/api/v1/send-sms";

export interface SmsMessage {
  to: string;         // E.164 or BD-local phone number (e.g. "01712345678")
  message: string;    // plain text, 160-char GSM segments (shorter for Unicode)
  clientRef?: string; // optional idempotency / correlation reference
}

export const isSmsConfigured = (): boolean =>
  Boolean(process.env.SMS_API_KEY);

// Zend accepts international format without the leading "+". "01712345678" -> "8801712345678".
const toE164 = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("88")) return digits;
  if (digits.startsWith("0")) return `88${digits}`;
  return `88${digits}`;
};

const sendViaZend = async (
  url: string,
  key: string,
  sender: string,
  msg: SmsMessage
): Promise<{ sent: boolean; provider: string; details?: unknown }> => {
  const host = new URL(url).host;
  const body: Record<string, string> = {
    recipient: toE164(msg.to),
    sender_id: sender,
    message: msg.message,
  };
  if (msg.clientRef) body.client_ref = msg.clientRef;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const raw = await response.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }

    // Zend envelope: { success, code, message, data }. Only code 1000 is a real
    // send; any other code is a business error (invalid key, insufficient balance,
    // sender not approved, TPS limit, etc. — see Zend docs for the full table).
    const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as {
      success?: boolean; code?: number; message?: string;
    };
    const ok = response.ok && envelope.success === true && envelope.code === 1000;

    if (!ok) {
      console.error(
        `❌ SMS send failed (HTTP ${response.status}) via ${host}:`,
        JSON.stringify(parsed).slice(0, 500)
      );
      return { sent: false, provider: host, details: parsed };
    }
    // Log msgid so the send can be traced on the Zend dashboard even if the
    // handset never receives it. SMS text is not logged.
    console.log(`✅ SMS accepted by ${host}:`, JSON.stringify(parsed).slice(0, 300));
    return { sent: true, provider: host, details: parsed };
  } catch (error) {
    console.error(`❌ SMS send error (${host}):`, (error as Error).message);
    return { sent: false, provider: host };
  }
};

const sendSmsViaProvider = async (
  msg: SmsMessage
): Promise<{ sent: boolean; provider: string }> => {
  const url = process.env.SMS_PROVIDER_URL || ZEND_DEFAULT_URL;
  const key = process.env.SMS_API_KEY;
  const sender = process.env.SMS_SENDER_ID || "GlobalShelfBD";
  if (!key) return { sent: false, provider: "none" };

  const result = await sendViaZend(url, key, sender, msg);
  return { sent: result.sent, provider: result.provider };
};

export const sendSms = async (
  msg: SmsMessage
): Promise<{ sent: boolean; provider: string }> => {
  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "development") {
      // Make the fallback impossible to miss: this is NOT a real SMS send.
      console.log(
        `⚠️  SMS NOT SENT (SMS_API_KEY not set). Add it to .env to send via Zend SMS.\n` +
          `   dev-console fallback → ${msg.to}: ${msg.message}`
      );
      return { sent: true, provider: "dev-console" };
    }
    console.error(`❌ SMS NOT SENT: SMS_API_KEY not configured`);
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

// Single-use login/register OTP (shorter wording).
export const sendLoginOtpSms = (phoneNumber: string, otp: string, minutes: number) =>
  sendSms({
    to: phoneNumber,
    message: `${otp} is your GlobalShelfBD login code. Expires in ${minutes} minutes. Do not share this code.`,
  });
