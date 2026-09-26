import { Schema, model } from "mongoose";

// Site-wide editable content stored as one document per key (e.g. "footer")
export interface FooterLink {
  label: string;
  url: string;
}

export interface FooterColumn {
  title: string;
  links: FooterLink[];
}

export interface FooterContent {
  logoUrl: string;
  aboutText: string;
  contact: {
    phone: string;
    email: string;
    address: string;
  };
  socialLinks: {
    facebook: string;
    instagram: string;
    youtube: string;
    tiktok: string;
    twitter: string;
    linkedin: string;
    whatsapp: string;
  };
  columns: FooterColumn[];
  copyrightText: string;
}

export const SOCIAL_NETWORKS = ["facebook", "instagram", "youtube", "tiktok", "twitter", "linkedin", "whatsapp"] as const;

export const emptyFooter = (): FooterContent => ({
  logoUrl: "",
  aboutText: "",
  contact: { phone: "", email: "", address: "" },
  socialLinks: { facebook: "", instagram: "", youtube: "", tiktok: "", twitter: "", linkedin: "", whatsapp: "" },
  columns: [],
  copyrightText: "",
});

export interface ISiteSetting {
  key: string;
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const siteSettingSchema = new Schema<ISiteSetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    // Keep empty objects (e.g. socialLinks: {}) instead of dropping them
    minimize: false,
  }
);

const SiteSetting = model<ISiteSetting>("SiteSetting", siteSettingSchema);
export default SiteSetting;
