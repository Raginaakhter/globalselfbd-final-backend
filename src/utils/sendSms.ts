// SMS integration seam. No SMS provider is configured in this project yet, so by
// default this module logs the message in development and refuses to send in
// production. Set SMS_PROVIDER_URL + SMS_API_KEY (and SMS_SENDER_ID) in .env to
// wire a real HTTP SMS gateway (e.g. SSL Wireless, Alpha SMS, BulkSMSBD).
//
// To add a provider: implement sendSmsViaProvider() below using fetch() against
// SMS_PROVIDER_URL. Keep the shape — return { success, provider }.

export interface SmsMessage {
  to: string;      // E.164 or BD-local phone number (e.g. "01712345678")
  message: string; // plain text, 160-char segments
}

export const isSmsConfigured = (): boolean =>
  Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_API_KEY);

const sendSmsViaProvider = async (msg: SmsMessage): Promise<{ sent: boolean; provider: string }> => {
  const url = process.env.SMS_PROVIDER_URL;
  const key = process.env.SMS_API_KEY;
  const sender = process.env.SMS_SENDER_ID || "GlobalShelfBD";
  if (!url || !key) return { sent: false, provider: "none" };

  // Minimal, provider-agnostic POST. Adjust the body/headers to match your provider's docs.
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ to: msg.to, from: sender, message: msg.message }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`❌ SMS send failed (${response.status}):`, text.slice(0, 300));
      return { sent: false, provider: new URL(url).host };
    }
    return { sent: true, provider: new URL(url).host };
  } catch (error) {
    console.error("❌ SMS send error:", (error as Error).message);
    return { sent: false, provider: "error" };
  }
};

export const sendSms = async (msg: SmsMessage): Promise<{ sent: boolean; provider: string }> => {
  if (!isSmsConfigured()) {
    if (process.env.NODE_ENV === "development") {
      console.log(`📱 [dev] SMS → ${msg.to}: ${msg.message}`);
      return { sent: true, provider: "dev-console" };
    }
    return { sent: false, provider: "none" };
  }
  return sendSmsViaProvider(msg);
};

export const sendPasswordResetOtpSms = (
  user: { fullName: string; phoneNumber: string },
  otp: string,
  minutes: number
) =>
  sendSms({
    to: user.phoneNumber,
    message: `${otp} is your GlobalShelfBD password reset code. It expires in ${minutes} minutes. Do not share this code.`,
  });
