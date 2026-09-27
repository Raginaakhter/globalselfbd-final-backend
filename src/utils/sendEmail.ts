import AppError from "./AppError";

// Emails are sent through Resend's HTTPS API (no SMTP ports, works on any host)
const RESEND_URL = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const isEmailConfigured = (): boolean => Boolean(process.env.RESEND_API_KEY);

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape user-provided text before putting it into email HTML
export const escapeHtml = (text: unknown): string => String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export const sendEmail = async ({ to, subject, html, text }: EmailMessage): Promise<string | undefined> => {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "GlobalShelfBD <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
      text,
    }),
    signal: AbortSignal.timeout(10000),
  });

  const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    console.error(`❌ Email failed (${response.status}):`, result.message || result);
    throw new AppError("Email could not be sent, please try again later", 502);
  }
  return result.id;
};

export interface BatchEmail extends EmailMessage {
  headers?: Record<string, string>;
}

// Send up to 100 different emails in one request (Resend batch API).
// Returns how many were accepted; a failed request counts all of its emails as failed.
export const sendEmailBatch = async (messages: BatchEmail[]): Promise<{ sent: number; failed: number }> => {
  if (messages.length === 0) return { sent: 0, failed: 0 };
  const from = process.env.EMAIL_FROM || "GlobalShelfBD <onboarding@resend.dev>";
  try {
    const response = await fetch(`${RESEND_URL}/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        messages.map((m) => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers }))
      ),
      signal: AbortSignal.timeout(30000),
    });
    const result = (await response.json().catch(() => ({}))) as { data?: { id: string }[]; message?: string };
    if (!response.ok) {
      console.error(`❌ Batch email failed (${response.status}):`, result.message || result);
      return { sent: 0, failed: messages.length };
    }
    const sent = result.data?.length ?? messages.length;
    return { sent, failed: messages.length - sent };
  } catch (error) {
    console.error("❌ Batch email failed:", (error as Error).message);
    return { sent: 0, failed: messages.length };
  }
};

// Simple branded layout shared by all emails
export const emailLayout = (title: string, bodyHtml: string): string => `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
  <h2 style="margin:0 0 16px;color:#111827">${title}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="font-size:12px;color:#6b7280;margin:0">GlobalShelfBD</p>
</div>`;

export const sendPasswordResetOtpEmail = (user: { fullName: string; email: string }, otp: string, minutes: number) =>
  sendEmail({
    to: user.email,
    subject: `${otp} is your GlobalShelfBD password reset code`,
    html: emailLayout(
      "Password reset code",
      `<p>Hi ${escapeHtml(user.fullName)},</p>
       <p>Use this code to reset your password:</p>
       <p style="margin:24px 0;text-align:center">
         <span style="display:inline-block;background:#f3f4f6;border-radius:8px;padding:16px 24px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:monospace;color:#111827">${otp}</span>
       </p>
       <p>This code expires in <strong>${minutes} minutes</strong>. Do not share it with anyone. GlobalShelfBD will never ask for this code.</p>
       <p style="font-size:13px;color:#6b7280">If you did not request this, you can ignore this email. Your password will not change.</p>`
    ),
    text: `Hi ${user.fullName},\n\nYour GlobalShelfBD password reset code is: ${otp}\n\nIt expires in ${minutes} minutes. Do not share it with anyone.\n\nIf you did not request this, ignore this email.`,
  });
