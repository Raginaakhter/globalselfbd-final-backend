import type { INewsletterCampaign, CampaignType } from "../models/NewsletterCampaign";
import type { IProduct } from "../models/Product";
import { escapeHtml } from "./sendEmail";
import { getFinalPrice } from "./productView";

type CampaignContent = Pick<INewsletterCampaign, "type" | "subject" | "heading" | "message" | "buttonText" | "buttonLink">;
export type CampaignProduct = Pick<IProduct, "productTitle" | "slug" | "thumbnail" | "customerSellPrice" | "customerSpecialPrice">;

// Website address for links inside emails
export const siteUrl = (): string =>
  (process.env.SITE_URL || (process.env.CLIENT_URL || "").split(",")[0] || "http://localhost:3000").trim().replace(/\/+$/, "");

// Emails need absolute links: "/offers" -> "https://site.com/offers"
const absolute = (link: string): string => (link.startsWith("/") ? `${siteUrl()}${link}` : link);

export const unsubscribeUrl = (token: string): string => `${siteUrl()}/newsletter/unsubscribe?token=${token}`;

const money = (n: number): string => `৳${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const BADGES: Record<CampaignType, string> = {
  NEW_PRODUCT: "New arrival",
  OFFER: "Special offer",
  ANNOUNCEMENT: "News",
};

const productCard = (p: CampaignProduct): string => {
  const final = getFinalPrice(p);
  const url = `${siteUrl()}/product/${encodeURIComponent(p.slug)}`;
  const oldPrice =
    p.customerSpecialPrice != null
      ? ` <span style="color:#9ca3af;text-decoration:line-through;font-size:13px">${money(p.customerSellPrice)}</span>`
      : "";
  return `
  <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="120" valign="top"><a href="${escapeHtml(url)}"><img src="${escapeHtml(p.thumbnail)}" width="110" alt="${escapeHtml(p.productTitle)}" style="display:block;border-radius:8px;border:1px solid #e5e7eb;max-width:110px"></a></td>
      <td valign="top" style="padding-left:12px">
        <div style="font-size:15px;font-weight:bold;color:#111827">${escapeHtml(p.productTitle)}</div>
        <div style="margin:6px 0 10px;font-size:15px;color:#006a4e;font-weight:bold">${money(final)}${oldPrice}</div>
        <a href="${escapeHtml(url)}" style="background:#006a4e;color:#ffffff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:13px;display:inline-block">Shop now</a>
      </td>
    </tr></table>
  </td></tr>`;
};

// Build one subscriber's email (the unsubscribe link is personal)
export const renderCampaignEmail = (
  campaign: CampaignContent,
  products: CampaignProduct[],
  unsubscribeToken: string
) => {
  const unsub = unsubscribeUrl(unsubscribeToken);
  const heading = campaign.heading || campaign.subject;
  const paragraphs = campaign.message
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 12px;line-height:1.6">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const button =
    campaign.buttonText && campaign.buttonLink
      ? `<p style="margin:20px 0"><a href="${escapeHtml(absolute(campaign.buttonLink))}" style="background:#111827;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(campaign.buttonText)}</a></p>`
      : "";

  const html = `
<div style="background:#f3f5f4;padding:24px 12px;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px">
    <tr><td style="padding:24px 24px 8px">
      <div style="font-size:18px;font-weight:bold;color:#111827">GlobalShelf<span style="color:#006a4e">BD</span></div>
    </td></tr>
    <tr><td style="padding:8px 24px 0">
      <span style="display:inline-block;background:#dcefe7;color:#006a4e;font-size:12px;font-weight:bold;padding:4px 10px;border-radius:999px">${BADGES[campaign.type]}</span>
      <h1 style="font-size:22px;color:#111827;margin:12px 0">${escapeHtml(heading)}</h1>
      <div style="color:#374151;font-size:15px">${paragraphs}</div>
      ${button}
    </td></tr>
    ${products.length ? `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${products.map(productCard).join("")}</table></td></tr>` : ""}
    <tr><td style="padding:24px;color:#6b7280;font-size:12px;line-height:1.6">
      You are receiving this because you subscribed to GlobalShelfBD news and offers.<br>
      <a href="${escapeHtml(unsub)}" style="color:#6b7280">Unsubscribe</a>
    </td></tr>
  </table>
</div>`;

  const text = [
    heading,
    "",
    campaign.message,
    campaign.buttonText && campaign.buttonLink ? `\n${campaign.buttonText}: ${absolute(campaign.buttonLink)}` : "",
    ...products.map((p) => `\n- ${p.productTitle}: ${money(getFinalPrice(p))} ${siteUrl()}/product/${p.slug}`),
    "",
    `Unsubscribe: ${unsub}`,
  ].join("\n");

  return {
    subject: campaign.subject,
    html,
    text,
    headers: { "List-Unsubscribe": `<${unsub}>` },
  };
};
