import { Schema, model, type ClientSession } from "mongoose";

// Atomic sequence numbers (e.g. order numbers ORD-1001, ORD-1002, ...)
interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = model<ICounter>("Counter", counterSchema);

export const nextSequence = async (name: string, start = 0, session?: ClientSession): Promise<number> => {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    [{ $set: { seq: { $add: [{ $ifNull: ["$seq", start] }, 1] } } }],
    { upsert: true, returnDocument: "after", session, updatePipeline: true }
  );
  if (!counter) throw new Error(`Counter ${name} could not be updated`);
  return counter.seq;
};

export default Counter;
