import type { Types } from "mongoose";
import Permission from "../models/Permission";
import Role from "../models/Role";
import RolePermission from "../models/RolePermission";
import User from "../models/User";
import { PERMISSIONS, DEFAULT_ROLES, ROLES } from "./permissions";

interface MongoWriteError {
  code?: number;
  err?: { code?: number };
  writeErrors?: MongoWriteError[];
}

// Two server processes seeding at the same moment can race on unique indexes; that is harmless
const ignoreDuplicates = async <T>(promise: Promise<T>): Promise<T | undefined> => {
  try {
    return await promise;
  } catch (error) {
    const errors = (error as MongoWriteError).writeErrors || [error as MongoWriteError];
    if (!errors.every((e) => (e.code || e.err?.code) === 11000)) throw error;
    return undefined;
  }
};

// Idempotent: safe to run on every server start.
// - Adds any new permissions from config/permissions.ts
// - Creates missing default roles with their default permissions
//   (existing roles are NOT overwritten, so admin changes are kept)
// - Keeps the Admin role in sync with every permission
// - A permission added to the code later is given to the default roles that list it,
//   only when that permission is first created (so admin removals are respected)
const seedRbac = async (): Promise<void> => {
  const existingNames = new Set((await Permission.find().select("name").lean()).map((p) => p.name));
  const newNames = new Set(PERMISSIONS.map((p) => p.name).filter((name) => !existingNames.has(name)));
  const isFirstRun = existingNames.size === 0;

  await ignoreDuplicates(
    Permission.bulkWrite(
      PERMISSIONS.map((p) => ({
        updateOne: {
          filter: { name: p.name },
          update: { $set: { module: p.module, action: p.action, description: p.description } },
          upsert: true,
        },
      })),
      { ordered: false }
    )
  );
  const allPermissions = await Permission.find();
  const idByName = new Map(allPermissions.map((p) => [p.name, p._id]));
  const idsFor = (names: string[]): Types.ObjectId[] =>
    names.map((n) => idByName.get(n)).filter((id): id is Types.ObjectId => Boolean(id));

  for (const def of DEFAULT_ROLES) {
    const found = await Role.findOne({ name: def.name });
    const isNew = !found;
    const role = found ?? (await Role.create({ name: def.name, description: def.description, isProtected: def.isProtected }));
    if (!isNew && role.isProtected !== def.isProtected) {
      role.isProtected = def.isProtected;
      await role.save();
    }

    let wanted: Types.ObjectId[] = [];
    if (def.name === ROLES.ADMIN) {
      wanted = allPermissions.map((p) => p._id);
    } else if (isNew) {
      wanted = idsFor(def.permissions);
    } else if (!isFirstRun && newNames.size) {
      const added = def.permissions.filter((n) => newNames.has(n));
      wanted = idsFor(added);
      if (wanted.length) {
        console.log(`🔑 New permissions added to ${def.name}: ${added.join(", ")}`);
      }
    }

    if (wanted.length) {
      const existing = new Set(
        (await RolePermission.find({ role: role._id }).lean()).map((rp) => String(rp.permission))
      );
      const missing = wanted.filter((id) => !existing.has(String(id)));
      if (missing.length) {
        await ignoreDuplicates(
          RolePermission.insertMany(
            missing.map((permission) => ({ role: role._id, permission })),
            { ordered: false }
          )
        );
      }
    }
  }
};

// Users created before the role system had role "user"/"admin" strings or no status.
// Move them to the Customer role (never auto-promote to Admin).
const migrateLegacyUsers = async (): Promise<void> => {
  const customerRole = await Role.findOne({ name: ROLES.CUSTOMER });
  if (!customerRole) throw new Error("Customer role is missing after seeding");
  const { modifiedCount } = await User.collection.updateMany(
    { $or: [{ role: { $not: { $type: "objectId" } } }, { role: { $exists: false } }] },
    { $set: { role: customerRole._id } }
  );
  await User.collection.updateMany({ status: { $exists: false } }, { $set: { status: "ACTIVE" } });
  // Old link-based reset tokens are no longer used (replaced by OTP)
  await User.collection.updateMany({ passwordResetToken: { $exists: true } }, { $unset: { passwordResetToken: "" } });
  if (modifiedCount) {
    console.log(`🔄 ${modifiedCount} legacy user(s) moved to the Customer role`);
  }
};

// Create the first Admin user from .env if no Admin user exists yet
const seedAdminUser = async (): Promise<void> => {
  const adminRole = await Role.findOne({ name: ROLES.ADMIN });
  if (!adminRole) throw new Error("Admin role is missing after seeding");
  if (await User.exists({ role: adminRole._id })) return;

  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn("⚠️  No Admin user exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create one.");
    return;
  }

  const existing = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (existing) {
    existing.role = adminRole._id;
    existing.status = "ACTIVE";
    await existing.save({ validateBeforeSave: false });
    console.log(`👑 Existing user ${ADMIN_EMAIL} promoted to Admin`);
    return;
  }

  await User.create({
    fullName: ADMIN_NAME || "Super Admin",
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: adminRole._id,
  });
  console.log(`👑 Admin user created: ${ADMIN_EMAIL}`);
};

export const seedDatabase = async (): Promise<void> => {
  await seedRbac();
  await migrateLegacyUsers();
  await seedAdminUser();
  console.log("🌱 Roles & permissions are up to date");
};
