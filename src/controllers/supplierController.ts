import type { Request, Response } from "express";
import Supplier from "../models/Supplier";
import Shipment from "../models/Shipment";
import InventoryLot from "../models/InventoryLot";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { assertObjectId, escapeRegex, getPagination, queryString } from "../utils/validators";
import { STATUSES, type Status } from "../types/common";

type Body = Record<string, unknown>;

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

const text = (value: unknown, label: string, max: number, required = false): string => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AppError(`${label} is required`, 400);
    return "";
  }
  if (typeof value !== "string") throw new AppError(`${label} must be text`, 400);
  const trimmed = value.trim();
  if (required && !trimmed) throw new AppError(`${label} is required`, 400);
  if (trimmed.length > max) throw new AppError(`${label} cannot exceed ${max} characters`, 400);
  return trimmed;
};

const parseSupplierBody = (body: Body, { requireName = false }: { requireName?: boolean } = {}) => {
  const data: Partial<{
    name: string;
    contactPerson: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
    status: Status;
  }> = {};
  if (body.name !== undefined || requireName) {
    data.name = text(body.name, "name", 160, requireName);
  }
  if (body.contactPerson !== undefined) data.contactPerson = text(body.contactPerson, "contactPerson", 120);
  if (body.phone !== undefined) data.phone = text(body.phone, "phone", 30);
  if (body.email !== undefined) {
    const email = text(body.email, "email", 160);
    if (email && !EMAIL_REGEX.test(email)) throw new AppError("email must be a valid email", 400);
    data.email = email.toLowerCase();
  }
  if (body.address !== undefined) data.address = text(body.address, "address", 300);
  if (body.notes !== undefined) data.notes = text(body.notes, "notes", 1000);
  if (body.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(String(body.status))) {
      throw new AppError("status must be ACTIVE or INACTIVE", 400);
    }
    data.status = body.status as Status;
  }
  return data;
};

// @desc    List suppliers (search, status filter, pagination)
// @route   GET /api/admin/inventory/suppliers
// @access  suppliers.view
export const listSuppliers = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const status = queryString(req.query.status);
  const filter: Record<string, unknown> = {};
  if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new AppError("status must be ACTIVE or INACTIVE", 400);
    }
    filter.status = status;
  }
  if (search && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ name: pattern }, { contactPerson: pattern }, { phone: pattern }, { email: pattern }];
  }

  const [suppliers, total] = await Promise.all([
    Supplier.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Supplier.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    message: "Suppliers fetched successfully",
    data: {
      suppliers,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// @desc    One supplier (and how many shipments reference it)
// @route   GET /api/admin/inventory/suppliers/:id
// @access  suppliers.view
export const getSupplier = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "supplier ID");
  const supplier = await Supplier.findById(req.params.id).lean();
  if (!supplier) throw new AppError("Supplier not found", 404);
  const [shipmentCount, lotCount] = await Promise.all([
    Shipment.countDocuments({ supplierId: supplier._id }),
    InventoryLot.countDocuments({ supplierId: supplier._id }),
  ]);
  res.status(200).json({
    success: true,
    message: "Supplier fetched successfully",
    data: { ...supplier, shipmentCount, lotCount },
  });
};

// @desc    Create a supplier
// @route   POST /api/admin/inventory/suppliers
// @access  suppliers.create
export const createSupplier = async (req: Request, res: Response) => {
  const data = parseSupplierBody((req.body || {}) as Body, { requireName: true });
  if (await Supplier.exists({ name: data.name })) {
    throw new AppError("A supplier with this name already exists", 409);
  }
  const supplier = await Supplier.create(data);
  await logActivity(req, { action: "SUPPLIER_CREATED", newValue: { supplierId: supplier._id, name: supplier.name } });
  res.status(201).json({ success: true, message: "Supplier created successfully", data: supplier });
};

// @desc    Update a supplier (send only the fields to change)
// @route   PUT /api/admin/inventory/suppliers/:id
// @access  suppliers.update
export const updateSupplier = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "supplier ID");
  const supplier = await Supplier.findById(req.params.id);
  if (!supplier) throw new AppError("Supplier not found", 404);

  const data = parseSupplierBody((req.body || {}) as Body);
  if (Object.keys(data).length === 0) throw new AppError("Send at least one field to update", 400);
  if (data.name && data.name !== supplier.name) {
    if (await Supplier.exists({ _id: { $ne: supplier._id }, name: data.name })) {
      throw new AppError("A supplier with this name already exists", 409);
    }
  }

  const before = supplier.toObject();
  supplier.set(data);
  await supplier.save();

  await logActivity(req, {
    action: "SUPPLIER_UPDATED",
    oldValue: { supplierId: before._id, name: before.name, status: before.status },
    newValue: { supplierId: supplier._id, name: supplier.name, status: supplier.status },
  });

  res.status(200).json({ success: true, message: "Supplier updated successfully", data: supplier });
};

// @desc    Delete (or deactivate) a supplier. Soft-deletes if any shipment/lot
//          references it — historical records are never broken.
// @route   DELETE /api/admin/inventory/suppliers/:id
// @access  suppliers.delete
export const deleteSupplier = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "supplier ID");
  const supplier = await Supplier.findById(req.params.id);
  if (!supplier) throw new AppError("Supplier not found", 404);

  const [hasShipments, hasLots] = await Promise.all([
    Shipment.exists({ supplierId: supplier._id }),
    InventoryLot.exists({ supplierId: supplier._id }),
  ]);

  if (hasShipments || hasLots) {
    supplier.status = "INACTIVE";
    await supplier.save();
    await logActivity(req, {
      action: "SUPPLIER_DELETED",
      oldValue: { supplierId: supplier._id, name: supplier.name },
      newValue: { softDeleted: true },
    });
    return res.status(200).json({
      success: true,
      message: "Supplier has history, so it was deactivated instead of deleted",
      data: { _id: supplier._id, name: supplier.name, status: supplier.status, deleted: false },
    });
  }

  await supplier.deleteOne();
  await logActivity(req, {
    action: "SUPPLIER_DELETED",
    oldValue: { supplierId: supplier._id, name: supplier.name },
    newValue: { deleted: true },
  });

  return res.status(200).json({
    success: true,
    message: "Supplier deleted successfully",
    data: { _id: supplier._id, name: supplier.name, deleted: true },
  });
};
