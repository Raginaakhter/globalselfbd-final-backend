// One-off script: drop legacy `email_1` / `phoneNumber_1` indexes on the users
// collection so Mongoose can recreate them with the schema's current
// partialFilterExpression (which allows multiple users to share an empty
// phone/email). Also clears orphan empty strings before the new index builds.
//
// Usage: npx tsx scripts/fix-user-indexes.ts
//
// Safe to re-run.
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../src/config/db";
import User from "../src/models/User";

// Any index named email_1 / phoneNumber_1 that was created without the
// schema's partial filter is dropped so syncIndexes can recreate it.
const LEGACY_INDEX_NAMES = ["email_1", "phoneNumber_1"];

const matchesCurrentSchema = (idx: { partialFilterExpression?: unknown }): boolean => {
  const pfe = idx.partialFilterExpression as Record<string, unknown> | undefined;
  if (!pfe) return false;
  const first = Object.values(pfe)[0] as Record<string, unknown> | undefined;
  // Current schema uses { $type: "string", $gt: "" }. Anything else is a stale shape.
  return Boolean(first && first.$type === "string" && first.$gt === "");
};

const main = async () => {
  await connectDB();
  const collection = User.collection;

  const before = await collection.indexes();
  console.log("Indexes before:");
  before.forEach((idx) => console.log(`  ${idx.name}  key=${JSON.stringify(idx.key)}  partial=${JSON.stringify(idx.partialFilterExpression || null)}`));

  for (const name of LEGACY_INDEX_NAMES) {
    const idx = before.find((i) => i.name === name);
    if (!idx) {
      console.log(`• ${name}: not present, skipping`);
      continue;
    }
    // Only drop if the existing index does NOT match the current schema spec
    // (otherwise we'd needlessly rebuild a correct index).
    if (matchesCurrentSchema(idx)) {
      console.log(`• ${name}: already matches current schema, skipping`);
      continue;
    }
    try {
      await collection.dropIndex(name);
      console.log(`✓ dropped legacy ${name}`);
    } catch (error) {
      console.error(`✗ could not drop ${name}:`, (error as Error).message);
    }
  }

  // Rebuild the schema-defined indexes (partial, unique on non-empty values).
  await User.syncIndexes();
  console.log("✓ User.syncIndexes() done");

  const after = await collection.indexes();
  console.log("Indexes after:");
  after.forEach((idx) => console.log(`  ${idx.name}  key=${JSON.stringify(idx.key)}  partial=${JSON.stringify(idx.partialFilterExpression || null)}`));

  await mongoose.disconnect();
};

main().catch((error) => {
  console.error("❌ Index fix failed:", error);
  process.exit(1);
});
