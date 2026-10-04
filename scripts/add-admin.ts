// One-off script: add (or promote) an Admin user by phone number.
// Usage: npx tsx scripts/add-admin.ts
//
// Edit the constants below for the account to create, then run once.
// Safe to re-run: an existing phone is promoted + password reset instead of duplicated.
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../src/config/db";
import User from "../src/models/User";
import Role from "../src/models/Role";
import { ROLES } from "../src/config/permissions";
import { normalizeBdPhone } from "../src/utils/validators";

const FULL_NAME = "Ragina Akter";
const PHONE_RAW = "01613033765";
const PASSWORD = "123456";

const main = async () => {
  const phoneNumber = normalizeBdPhone(PHONE_RAW);
  if (!phoneNumber) {
    throw new Error(`Invalid Bangladeshi phone number: ${PHONE_RAW}`);
  }

  await connectDB();

  const adminRole = await Role.findOne({ name: ROLES.ADMIN });
  if (!adminRole) {
    throw new Error(
      "Admin role is missing. Start the server once (npm run dev) so seedDatabase() runs, then try again."
    );
  }

  const existing = await User.findOne({ phoneNumber });
  if (existing) {
    const wasAdmin = String(existing.role) === String(adminRole._id);
    existing.fullName = FULL_NAME;
    existing.role = adminRole._id;
    existing.status = "ACTIVE";
    existing.password = PASSWORD;
    await existing.save();
    console.log(
      wasAdmin
        ? `✓ Admin already existed with ${phoneNumber} — password reset for ${FULL_NAME}`
        : `✓ Existing user ${phoneNumber} promoted to Admin and password reset`
    );
  } else {
    const user = await User.create({
      fullName: FULL_NAME,
      phoneNumber,
      password: PASSWORD,
      role: adminRole._id,
    });
    console.log(`✓ Admin created: ${user.fullName} (${user.phoneNumber})`);
  }

  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("❌", (error as Error).message);
  process.exit(1);
});
