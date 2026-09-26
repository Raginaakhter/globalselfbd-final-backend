import type { Request, Response } from "express";
import SiteSetting, {
  emptyFooter,
  SOCIAL_NETWORKS,
  type FooterColumn,
  type FooterContent,
} from "../models/SiteSetting";
import AppError from "../utils/AppError";
import { isValidImageUrl } from "../utils/imageValidation";
import { isValidLink, optionalText, optionalLink } from "../utils/validators";

// Note: Express 5 forwards errors thrown in async handlers to the error handler

type Body = Record<string, unknown>;

const FOOTER_KEY = "footer";
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const LIMITS = { ABOUT: 1000, PHONE: 30, ADDRESS: 300, COPYRIGHT: 200, COLUMNS: 6, LINKS: 12, LABEL: 60 };

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);

// Stored footer merged over the defaults, so every field is always present
const loadFooter = async (): Promise<FooterContent> => {
  const doc = await SiteSetting.findOne({ key: FOOTER_KEY }).lean();
  const saved = (doc?.value || {}) as Partial<FooterContent>;
  const base = emptyFooter();
  return {
    ...base,
    ...saved,
    contact: { ...base.contact, ...(saved.contact || {}) },
    socialLinks: { ...base.socialLinks, ...(saved.socialLinks || {}) },
    columns: saved.columns || [],
  };
};

const parseColumns = (value: unknown): FooterColumn[] => {
  if (!Array.isArray(value)) throw new AppError("columns must be an array", 400);
  if (value.length > LIMITS.COLUMNS) throw new AppError(`Footer can have at most ${LIMITS.COLUMNS} columns`, 400);
  return value.map((col, i) => {
    if (!isObject(col)) throw new AppError(`columns[${i}] must be an object`, 400);
    const title = optionalText(col.title, `columns[${i}].title`, LIMITS.LABEL);
    if (!title) throw new AppError(`columns[${i}].title is required`, 400);
    const links = col.links === undefined ? [] : col.links;
    if (!Array.isArray(links)) throw new AppError(`columns[${i}].links must be an array`, 400);
    if (links.length > LIMITS.LINKS) throw new AppError(`A footer column can have at most ${LIMITS.LINKS} links`, 400);
    return {
      title,
      links: links.map((link, j) => {
        if (!isObject(link)) throw new AppError(`columns[${i}].links[${j}] must be an object`, 400);
        const label = optionalText(link.label, `columns[${i}].links[${j}].label`, LIMITS.LABEL);
        if (!label) throw new AppError(`columns[${i}].links[${j}].label is required`, 400);
        if (!isValidLink(link.url)) {
          throw new AppError(`columns[${i}].links[${j}].url must be a path like "/about" or a full http(s) URL`, 400);
        }
        return { label, url: link.url.trim() };
      }),
    };
  });
};

// Apply only the parts that were sent onto the current footer
const applyFooterUpdate = (footer: FooterContent, body: Body): FooterContent => {
  const next: FooterContent = JSON.parse(JSON.stringify(footer));

  if (body.logoUrl !== undefined) {
    if (body.logoUrl === null || body.logoUrl === "") next.logoUrl = "";
    else if (!isValidImageUrl(body.logoUrl)) throw new AppError("logoUrl must be a valid image URL", 400);
    else next.logoUrl = body.logoUrl.trim();
  }
  const about = optionalText(body.aboutText, "aboutText", LIMITS.ABOUT);
  if (about !== undefined) next.aboutText = about;
  const copyright = optionalText(body.copyrightText, "copyrightText", LIMITS.COPYRIGHT);
  if (copyright !== undefined) next.copyrightText = copyright;

  if (body.contact !== undefined) {
    if (!isObject(body.contact)) throw new AppError("contact must be an object", 400);
    const phone = optionalText(body.contact.phone, "contact.phone", LIMITS.PHONE);
    if (phone !== undefined) next.contact.phone = phone;
    const email = optionalText(body.contact.email, "contact.email", 100);
    if (email !== undefined) {
      if (email && !EMAIL_REGEX.test(email)) throw new AppError("contact.email must be a valid email", 400);
      next.contact.email = email.toLowerCase();
    }
    const address = optionalText(body.contact.address, "contact.address", LIMITS.ADDRESS);
    if (address !== undefined) next.contact.address = address;
  }

  if (body.socialLinks !== undefined) {
    if (!isObject(body.socialLinks)) throw new AppError("socialLinks must be an object", 400);
    for (const [network, url] of Object.entries(body.socialLinks)) {
      if (!(SOCIAL_NETWORKS as readonly string[]).includes(network)) {
        throw new AppError(`Unknown social network "${network}". Allowed: ${SOCIAL_NETWORKS.join(", ")}`, 400);
      }
      const link = optionalLink(url, `socialLinks.${network}`);
      if (link !== undefined) next.socialLinks[network as (typeof SOCIAL_NETWORKS)[number]] = link;
    }
  }

  if (body.columns !== undefined) next.columns = body.columns === null ? [] : parseColumns(body.columns);
  return next;
};

// @desc    Footer content (admin editor)
// @route   GET /api/settings/footer
// @access  settings.view
export const getFooter = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "Footer fetched successfully", data: await loadFooter() });
};

// @desc    Update the footer (send only the parts to change; "" clears a field)
// @route   PUT /api/settings/footer
// @access  settings.update
export const updateFooter = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  if (!isObject(body) || Object.keys(body).length === 0) throw new AppError("Send at least one footer field to update", 400);

  const footer = applyFooterUpdate(await loadFooter(), body);
  await SiteSetting.findOneAndUpdate({ key: FOOTER_KEY }, { $set: { value: footer } }, { upsert: true });

  res.status(200).json({ success: true, message: "Footer updated successfully", data: footer });
};

// @desc    Footer content for the website
// @route   GET /api/public/footer
// @access  Public
export const getPublicFooter = async (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "Footer fetched successfully", data: await loadFooter() });
};
