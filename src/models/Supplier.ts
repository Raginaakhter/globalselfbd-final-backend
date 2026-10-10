import { Schema, model, type HydratedDocument } from "mongoose";
import { STATUSES, type Status } from "../types/common";

// Supplier/vendor who provides stock. Soft-deletable (status INACTIVE) when
// historical shipments reference it; hard-deletable only when no shipment uses it.
export interface ISupplier {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

export type SupplierDocument = HydratedDocument<ISupplier>;

const supplierSchema = new Schema<ISupplier>(
  {
    name: { type: String, required: [true, "Supplier name is required"], trim: true, maxlength: 160, unique: true },
    contactPerson: { type: String, default: "", trim: true, maxlength: 120 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    status: { type: String, enum: STATUSES, default: "ACTIVE", index: true },
  },
  { timestamps: true }
);

const Supplier = model<ISupplier>("Supplier", supplierSchema);
export default Supplier;
