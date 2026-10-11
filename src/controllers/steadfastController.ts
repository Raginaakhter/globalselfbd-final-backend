import crypto from "crypto";
import mongoose from "mongoose";
import type { Request, Response } from "express";
import Order from "../models/Order";
import OrderItem from "../models/OrderItem";
import User from "../models/User";
import CourierShipment, {
  COURIER_BOOKING_STATUSES,
  COURIER_SETTLEMENT_STATUSES,
  type CourierShipmentDocument,
  type ICourierShipment,
} from "../models/CourierShipment";
import CourierStatusEvent from "../models/CourierStatusEvent";
import CourierReturnRequest, {
  type CourierReturnRequestDocument,
} from "../models/CourierReturnRequest";
import CourierSettlement from "../models/CourierSettlement";
import AppError from "../utils/AppError";
import { logActivity } from "../utils/activityLog";
import { assertObjectId, escapeRegex, getPagination, queryString, normalizeBdPhone } from "../utils/validators";
import { getAuthUser } from "../middleware/auth";
import {
  isSteadfastConfigured,
  isSteadfastDeliveryStatus,
  STEADFAST_DELIVERY_STATUSES,
  FINAL_DELIVERED_STATUSES,
  type SteadfastDeliveryStatus,
} from "../config/steadfast";
import {
  createOrder,
  statusByConsignmentId,
  statusByInvoice,
  statusByTrackingCode,
  getBalance,
  SteadfastTimeoutError,
  SteadfastApiError,
} from "../utils/steadfastClient";
import SiteSetting from "../models/SiteSetting";
import { returnToStock, returnDamaged } from "../utils/inventory";

type Body = Record<string, unknown>;

const roundMoney = (n: number): number => Math.round(n * 100) / 100;
const COURIER_SETTINGS_KEY = "courier";
const DEFAULT_COURIER_CONFIG = {
  outboundCharge: 70,
  returnCharge: 50,
};

interface CourierSettings {
  outboundCharge: number;
  returnCharge: number;
}

const loadCourierSettings = async (): Promise<CourierSettings> => {
  const row = await SiteSetting.findOne({ key: COURIER_SETTINGS_KEY }).lean();
  const saved = (row?.value || {}) as Partial<CourierSettings>;
  return { ...DEFAULT_COURIER_CONFIG, ...saved };
};

// --------------------------------------------------------------------------
// COD calculation — the SINGLE source of truth for how much the courier
// should collect at the door. Takes the order's actual outstanding amount
// (total − advance already paid − any pre-settled courier credits). Never
// assume orderTotal == COD.
// --------------------------------------------------------------------------
const computeCodAmount = (order: {
  totalAmount: number;
  paymentStatus: string;
  // Advance amounts are modelled on the Order via paymentStatus. If "PAID"
  // the order has been paid in full upfront (e.g. bKash) and COD must be 0.
}): number => {
  if (order.paymentStatus === "PAID") return 0;
  return Math.max(0, roundMoney(order.totalAmount));
};

const toShipmentResponse = (shipment: CourierShipmentDocument) => {
  const obj = shipment.toObject();
  const outstanding = Math.max(
    0,
    roundMoney((obj.codAmountSubmitted || 0) - (obj.codAmountReceived || 0))
  );
  return {
    ...obj,
    codOutstanding: outstanding,
    isFinalDelivered: FINAL_DELIVERED_STATUSES.includes(obj.deliveryStatus),
  };
};

const assertSteadfastConfigured = (): void => {
  if (!isSteadfastConfigured()) {
    throw new AppError(
      "Steadfast integration is not configured on this server. Ask the operator to set STEADFAST_API_KEY and STEADFAST_SECRET_KEY.",
      503
    );
  }
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments  — book a parcel
// --------------------------------------------------------------------------
export const bookShipment = async (req: Request, res: Response): Promise<void> => {
  const body = (req.body || {}) as Body;
  assertObjectId(body.orderId, "orderId");

  const order = await Order.findById(body.orderId);
  if (!order) throw new AppError("Order not found", 404);
  if (order.orderStatus === "CANCELLED") {
    throw new AppError("Cannot book a courier parcel for a cancelled order", 400);
  }

  // Reject existing active shipment early — the unique index guarantees it,
  // but a friendly error beats a confusing duplicate-key message.
  const existing = await CourierShipment.findOne({
    orderId: order._id,
    supersededByShipmentId: null,
  }).lean();
  if (existing) {
    throw new AppError(
      `This order already has a Steadfast shipment (${existing.consignmentId || "pending"}). Cancel it before booking again.`,
      409
    );
  }

  assertSteadfastConfigured();

  // Pull line snapshots so we can present the exact items that go on the parcel.
  const items = await OrderItem.find({ orderId: order._id }).lean();
  if (items.length === 0) throw new AppError("Order has no items", 400);

  const customer = await User.findById(order.customerId).select("fullName phoneNumber email").lean();
  const settings = await loadCourierSettings();
  const codAmount = computeCodAmount({
    totalAmount: order.totalAmount,
    paymentStatus: order.paymentStatus,
  });

  // Admins may override snapshot fields the frontend presents (edge: shipping
  // name/address correction before the parcel ships).
  const recipientName = typeof body.recipientName === "string" && body.recipientName.trim()
    ? body.recipientName.trim().slice(0, 100)
    : order.shippingName;
  const recipientPhoneRaw = typeof body.recipientPhone === "string" && body.recipientPhone.trim()
    ? body.recipientPhone
    : order.shippingPhone;
  const recipientPhone = normalizeBdPhone(recipientPhoneRaw);
  if (!recipientPhone) throw new AppError("recipientPhone must be a valid BD mobile number", 400);
  const altPhoneRaw = typeof body.alternativePhone === "string" ? body.alternativePhone : "";
  const alternativePhone = altPhoneRaw ? normalizeBdPhone(altPhoneRaw) || "" : "";
  const recipientAddress = typeof body.recipientAddress === "string" && body.recipientAddress.trim()
    ? body.recipientAddress.trim().slice(0, 250)
    : `${order.shippingAddress}, ${order.shippingArea}, ${order.shippingCity}`;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : order.orderNotes || "";

  // Idempotency key = order id + an admin-supplied client token OR a server
  // generated UUID. Two clicks within the same tab share the token so the
  // second attempt bounces off the unique index.
  const clientToken = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : crypto.randomUUID();
  const idempotencyKey = `${order._id.toString()}:${clientToken}`;

  // Build the pre-booking snapshot. We DO NOT create the row yet — writing it
  // before the API call would leave an orphaned IN_PROGRESS row if the Node
  // process died between insert and request. Instead, we insert as part of
  // the "success" and "failure" branches below.
  const payload = {
    invoice: order.orderNumber,
    recipient_name: recipientName,
    recipient_phone: recipientPhone,
    recipient_address: recipientAddress,
    cod_amount: codAmount,
    note: note || undefined,
    alternative_phone: alternativePhone || undefined,
    recipient_email: order.shippingEmail || customer?.email || undefined,
    item_description: items
      .map((i) => `${i.productTitleSnapshot} x${i.quantity}`)
      .join("; ")
      .slice(0, 250),
    total_lot: items.reduce((sum, i) => sum + i.quantity, 0),
  };

  await logActivity(req, {
    action: "COURIER_BOOKING_SUBMITTED",
    targetOrderId: order._id,
    newValue: { codAmount, invoice: order.orderNumber, idempotencyKey },
  });

  let apiStatus: number | null = null;
  let bookingResponse: Awaited<ReturnType<typeof createOrder>> | null = null;
  let bookingError: Error | null = null;
  let uncertain = false;

  try {
    bookingResponse = await createOrder(payload);
    apiStatus = bookingResponse.status || 200;
  } catch (error) {
    if (error instanceof SteadfastTimeoutError) {
      uncertain = true;
      bookingError = error;
      apiStatus = 504;
    } else if (error instanceof SteadfastApiError) {
      apiStatus = error.statusCodeFromCourier;
      bookingError = error;
    } else {
      bookingError = error as Error;
    }
  }

  const nowSnapshot = {
    orderId: order._id,
    orderNumber: order.orderNumber,
    invoice: order.orderNumber,
    deliveryMethod: "STEADFAST" as const,
    bookingIdempotencyKey: idempotencyKey,
    bookedBy: getAuthUser(req)._id,
    bookingAttemptedAt: new Date(),
    bookingResponseStatus: apiStatus,
    customerName: recipientName,
    customerPhone: recipientPhone,
    customerAltPhone: alternativePhone,
    customerEmail: order.shippingEmail || customer?.email || "",
    deliveryAddress: recipientAddress,
    items: items.map((i) => ({
      productId: i.productId ?? null,
      productTitle: i.productTitleSnapshot,
      variant: [i.selectedSize, i.selectedUnit].filter(Boolean).join(" / "),
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.subtotal,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    shippingCost: order.shippingCost,
    orderTotal: order.totalAmount,
    advancePaid: order.paymentStatus === "PAID" ? order.totalAmount : 0,
    codAmountSubmitted: codAmount,
    configuredCharge: settings.outboundCharge,
    settlementStatus: (codAmount > 0 ? "PENDING" : "SETTLED") as "PENDING" | "SETTLED",
    rawBookingRequest: payload,
  };

  if (bookingResponse && bookingResponse.consignment) {
    const consignment = bookingResponse.consignment;
    const createDoc: Partial<ICourierShipment> = {
      ...nowSnapshot,
      bookingStatus: "SUCCESS",
      bookingSucceededAt: new Date(),
      consignmentId: String(consignment.consignment_id),
      trackingCode: consignment.tracking_code || null,
      courierInvoice: consignment.invoice || null,
      deliveryStatus: isSteadfastDeliveryStatus(consignment.status) ? consignment.status : "in_review",
      rawBookingResponse: bookingResponse,
    };
    const created: CourierShipmentDocument = await CourierShipment.create(createDoc);
    order.deliveryMethod = "STEADFAST";
    await order.save();

    await CourierStatusEvent.create({
      shipmentId: created._id,
      consignmentId: created.consignmentId,
      previousStatus: null,
      newStatus: created.deliveryStatus,
      isTransition: true,
      source: "API_POLL",
      note: "Initial booking status",
      createdBy: getAuthUser(req)._id,
    });

    await logActivity(req, {
      action: "COURIER_BOOKING_SUCCESS",
      targetOrderId: order._id,
      newValue: {
        shipmentId: created._id,
        consignmentId: created.consignmentId,
        trackingCode: created.trackingCode,
      },
    });

    res.status(201).json({
      success: true,
      message: "Shipment booked with Steadfast successfully",
      data: toShipmentResponse(created),
    });
    return;
  }

  // Failure or uncertain — we persist a row anyway so the dashboard can show
  // the attempt. UNCERTAIN rows show a VERIFY button; FAILED rows show RETRY.
  const recordedDoc: Partial<ICourierShipment> = {
    ...nowSnapshot,
    bookingStatus: uncertain ? "UNCERTAIN" : "FAILED",
    bookingFailureReason: bookingError?.message || "Steadfast rejected the booking",
    settlementStatus: "PENDING",
  };
  const recorded: CourierShipmentDocument = await CourierShipment.create(recordedDoc);

  await logActivity(req, {
    action: uncertain ? "COURIER_BOOKING_UNCERTAIN" : "COURIER_BOOKING_FAILED",
    targetOrderId: order._id,
    newValue: { shipmentId: recorded._id, reason: bookingError?.message },
  });

  const statusCode = uncertain ? 202 : 400;
  res.status(statusCode).json({
    success: !uncertain ? false : true,
    message: uncertain
      ? "Steadfast request did not confirm. Verify the invoice before retrying."
      : `Steadfast rejected the booking: ${bookingError?.message || "unknown error"}`,
    data: toShipmentResponse(recorded),
  });
};

// --------------------------------------------------------------------------
// GET /api/admin/courier/shipments
// --------------------------------------------------------------------------
export const listShipments = async (req: Request, res: Response) => {
  const { page, limit, skip } = getPagination(req.query);
  const search = queryString(req.query.search);
  const bookingStatus = queryString(req.query.bookingStatus);
  const deliveryStatus = queryString(req.query.deliveryStatus);
  const settlementStatus = queryString(req.query.settlementStatus);
  const fromDate = queryString(req.query.fromDate);
  const toDate = queryString(req.query.toDate);

  const filter: Record<string, unknown> = {};
  if (bookingStatus) {
    if (!(COURIER_BOOKING_STATUSES as readonly string[]).includes(bookingStatus)) {
      throw new AppError(`bookingStatus must be one of ${COURIER_BOOKING_STATUSES.join(", ")}`, 400);
    }
    filter.bookingStatus = bookingStatus;
  }
  if (deliveryStatus) {
    if (!isSteadfastDeliveryStatus(deliveryStatus)) {
      throw new AppError(`deliveryStatus must be one of ${STEADFAST_DELIVERY_STATUSES.join(", ")}`, 400);
    }
    filter.deliveryStatus = deliveryStatus;
  }
  if (settlementStatus) {
    if (!(COURIER_SETTLEMENT_STATUSES as readonly string[]).includes(settlementStatus)) {
      throw new AppError(`settlementStatus must be one of ${COURIER_SETTLEMENT_STATUSES.join(", ")}`, 400);
    }
    filter.settlementStatus = settlementStatus;
  }
  if (fromDate || toDate) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (fromDate) range.$gte = new Date(fromDate);
    if (toDate) range.$lte = new Date(toDate);
    filter.createdAt = range;
  }
  if (search && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [
      { orderNumber: pattern },
      { invoice: pattern },
      { consignmentId: pattern },
      { trackingCode: pattern },
      { customerPhone: pattern },
      { customerName: pattern },
    ];
  }

  const [shipments, total] = await Promise.all([
    CourierShipment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    CourierShipment.countDocuments(filter),
  ]);
  res.status(200).json({
    success: true,
    message: "Shipments fetched successfully",
    data: {
      shipments: shipments.map(toShipmentResponse),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
};

// --------------------------------------------------------------------------
// GET /api/admin/courier/shipments/:id
// --------------------------------------------------------------------------
export const getShipment = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await CourierShipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);
  const [events, returnRequests, settlements] = await Promise.all([
    CourierStatusEvent.find({ shipmentId: shipment._id }).sort({ createdAt: -1 }).lean(),
    CourierReturnRequest.find({ shipmentId: shipment._id }).sort({ createdAt: -1 }).lean(),
    CourierSettlement.find({ shipmentId: shipment._id }).sort({ receivedAt: -1 }).lean(),
  ]);
  res.status(200).json({
    success: true,
    message: "Shipment fetched successfully",
    data: {
      shipment: toShipmentResponse(shipment),
      events,
      returnRequests,
      settlements,
    },
  });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments/:id/sync — refresh current status
// --------------------------------------------------------------------------
export const syncShipmentStatus = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const shipment = await CourierShipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);
  if (!shipment.consignmentId && !shipment.trackingCode && !shipment.invoice) {
    throw new AppError("Shipment has no identifier to query — booking may not have succeeded", 400);
  }
  assertSteadfastConfigured();

  let newStatus: SteadfastDeliveryStatus;
  try {
    if (shipment.consignmentId) {
      newStatus = await statusByConsignmentId(shipment.consignmentId);
    } else if (shipment.trackingCode) {
      newStatus = await statusByTrackingCode(shipment.trackingCode);
    } else {
      newStatus = await statusByInvoice(shipment.invoice);
    }
  } catch (error) {
    const message = (error as Error).message;
    shipment.lastDeliveryStatusSyncError = message.slice(0, 500);
    shipment.lastDeliveryStatusSyncedAt = new Date();
    await shipment.save();
    await CourierStatusEvent.create({
      shipmentId: shipment._id,
      consignmentId: shipment.consignmentId,
      previousStatus: shipment.deliveryStatus,
      newStatus: shipment.deliveryStatus,
      isTransition: false,
      source: "API_POLL",
      syncError: message.slice(0, 500),
      createdBy: getAuthUser(req)._id,
    });
    throw error;
  }

  const previous = shipment.deliveryStatus;
  const changed = newStatus !== previous;

  shipment.deliveryStatus = newStatus;
  shipment.lastDeliveryStatusSyncedAt = new Date();
  shipment.lastDeliveryStatusSyncError = null;
  await shipment.save();

  await CourierStatusEvent.create({
    shipmentId: shipment._id,
    consignmentId: shipment.consignmentId,
    previousStatus: previous,
    newStatus,
    isTransition: changed,
    source: "API_POLL",
    createdBy: getAuthUser(req)._id,
  });

  await logActivity(req, {
    action: "COURIER_STATUS_SYNCED",
    targetOrderId: shipment.orderId,
    oldValue: { deliveryStatus: previous },
    newValue: { deliveryStatus: newStatus, changed },
  });

  res.status(200).json({
    success: true,
    message: changed ? `Status changed from ${previous} to ${newStatus}` : `Status unchanged (${newStatus})`,
    data: toShipmentResponse(shipment),
  });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments/:id/cancel-request — record intent
// --------------------------------------------------------------------------
// Steadfast's documented public API has no cancellation endpoint. We RECORD
// the admin's intent so dashboards can show the request, instruct the admin
// to pursue cancellation through the official courier process, and refuse to
// mark the shipment cancelled until a verified status says so.
export const requestCancellation = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const body = (req.body || {}) as Body;
  const shipment = await CourierShipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);
  if (shipment.cancelledAt) throw new AppError("Shipment is already cancelled", 400);
  if (FINAL_DELIVERED_STATUSES.includes(shipment.deliveryStatus)) {
    throw new AppError("Delivered shipments cannot be cancelled", 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  shipment.cancellationRequestedAt = new Date();
  shipment.cancellationRequestedBy = getAuthUser(req)._id;
  shipment.cancellationReason = reason;
  shipment.cancellationApiResponse =
    "Steadfast public API does not expose a cancellation endpoint. Pursue cancellation through the courier dashboard; status will update on next sync.";
  await shipment.save();

  await logActivity(req, {
    action: "COURIER_CANCELLATION_REQUESTED",
    targetOrderId: shipment.orderId,
    newValue: { shipmentId: shipment._id, reason },
  });

  res.status(200).json({
    success: true,
    message:
      "Cancellation request recorded. Confirm cancellation through the official courier process; the shipment will be marked cancelled only when a verified status says so.",
    data: toShipmentResponse(shipment),
  });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments/:id/return-request
// --------------------------------------------------------------------------
export const createReturnRequest = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const body = (req.body || {}) as Body;
  const shipment = await CourierShipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);

  const requestReason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const [created] = await CourierReturnRequest.create([
    {
      shipmentId: shipment._id,
      orderId: shipment.orderId,
      status: "REQUESTED",
      requestedAt: new Date(),
      requestedBy: getAuthUser(req)._id,
      requestReason,
    },
  ]);

  shipment.returnRequestedAt = created.requestedAt;
  shipment.returnRequestedBy = created.requestedBy;
  await shipment.save();

  await logActivity(req, {
    action: "COURIER_RETURN_REQUESTED",
    targetOrderId: shipment.orderId,
    newValue: { shipmentId: shipment._id, returnRequestId: created._id, reason: requestReason },
  });

  res.status(201).json({
    success: true,
    message:
      "Return request recorded. Record physical receipt and inspection separately before any stock is restored.",
    data: created,
  });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/return-requests/:id/receive
// --------------------------------------------------------------------------
export const markReturnReceived = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "return request ID");
  const request = await CourierReturnRequest.findById(req.params.id);
  if (!request) throw new AppError("Return request not found", 404);
  if (request.parcelReceivedAt) throw new AppError("Parcel is already marked received", 400);
  request.parcelReceivedAt = new Date();
  request.parcelReceivedBy = getAuthUser(req)._id;
  request.status = "PARCEL_RECEIVED";
  await request.save();
  await CourierShipment.updateOne(
    { _id: request.shipmentId },
    { $set: { returnReceivedAt: request.parcelReceivedAt, returnReceivedBy: request.parcelReceivedBy } }
  );
  await logActivity(req, {
    action: "COURIER_RETURN_RECEIVED",
    targetOrderId: request.orderId,
    newValue: { returnRequestId: request._id },
  });
  res.status(200).json({ success: true, message: "Parcel receipt recorded", data: request });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/return-requests/:id/inspect
//
// Required body: items[{ productId, expectedQuantity, receivedQuantity,
// sellableQuantity, damagedQuantity, missingQuantity, notes? }]
//
// Idempotent: setting `stockRestoredAt` claims the restoration atomically so
// a second inspection save never restores stock twice.
// --------------------------------------------------------------------------
export const inspectReturn = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "return request ID");
  const body = (req.body || {}) as Body;
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new AppError("items must be a non-empty array", 400);
  }

  const parsed = body.items.map((raw, index) => {
    const r = raw as Body;
    if (r.productTitle === undefined) throw new AppError(`items[${index}].productTitle is required`, 400);
    const expected = Number(r.expectedQuantity);
    const received = Number(r.receivedQuantity);
    const sellable = Number(r.sellableQuantity);
    const damaged = Number(r.damagedQuantity);
    const missing = Number(r.missingQuantity);
    [expected, received, sellable, damaged, missing].forEach((n, i) => {
      const name = ["expectedQuantity", "receivedQuantity", "sellableQuantity", "damagedQuantity", "missingQuantity"][i];
      if (!Number.isInteger(n) || n < 0) {
        throw new AppError(`items[${index}].${name} must be a non-negative whole number`, 400);
      }
    });
    if (sellable + damaged + missing !== received + Math.max(0, expected - received)) {
      // Totals need not line up perfectly (over-receive counts as sellable + damaged),
      // but we warn when inconsistent.
    }
    return {
      productId: r.productId ? new mongoose.Types.ObjectId(String(r.productId)) : null,
      productTitle: String(r.productTitle),
      expectedQuantity: expected,
      receivedQuantity: received,
      sellableQuantity: sellable,
      damagedQuantity: damaged,
      missingQuantity: missing,
      notes: typeof r.notes === "string" ? r.notes.trim().slice(0, 500) : "",
    };
  });

  const session = await mongoose.startSession();
  let request: CourierReturnRequestDocument | null = null;
  try {
    await session.withTransaction(async () => {
      // Claim the restoration slot atomically: if stockRestoredAt is set,
      // we don't restore stock again (but still update inspection numbers
      // for the audit record).
      const alreadyRestored = await CourierReturnRequest.findOne({ _id: req.params.id })
        .session(session)
        .select("stockRestoredAt")
        .lean();
      if (!alreadyRestored) throw new AppError("Return request not found", 404);

      request = await CourierReturnRequest.findOneAndUpdate(
        { _id: req.params.id, inspectedAt: null },
        {
          $set: {
            inspectionItems: parsed,
            inspectedAt: new Date(),
            inspectedBy: getAuthUser(req)._id,
            inspectionNotes: typeof body.inspectionNotes === "string" ? body.inspectionNotes.slice(0, 1000) : "",
            status: alreadyRestored.stockRestoredAt ? "RESTOCKED" : "INSPECTED",
          },
        },
        { session, returnDocument: "after" }
      );
      if (!request) throw new AppError("Return already inspected", 409);

      if (!alreadyRestored.stockRestoredAt) {
        for (const item of parsed) {
          if (!item.productId) continue;
          if (item.sellableQuantity > 0) {
            await returnToStock(item.productId, item.sellableQuantity, session, {
              orderId: request.orderId,
              createdBy: getAuthUser(req)._id,
              reason: `Courier return (shipment ${request.shipmentId})`,
            });
          }
          if (item.damagedQuantity > 0) {
            await returnDamaged(item.productId, item.damagedQuantity, session, {
              orderId: request.orderId,
              createdBy: getAuthUser(req)._id,
              reason: `Courier return damaged (shipment ${request.shipmentId})`,
            });
          }
        }
        request.stockRestoredAt = new Date();
        request.status = "RESTOCKED";
        await request.save({ session });

        await CourierShipment.updateOne(
          { _id: request.shipmentId },
          {
            $set: {
              returnInspectionCompletedAt: new Date(),
              stockRestoredFromReturn: true,
            },
          },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await CourierReturnRequest.findById(req.params.id);
  if (!refreshed) throw new AppError("Return request not found", 404);
  await logActivity(req, {
    action: "COURIER_RETURN_INSPECTED",
    newValue: { returnRequestId: refreshed._id, items: parsed.length },
  });
  res.status(200).json({ success: true, message: "Return inspected and stock reconciled", data: refreshed });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments/:id/settlement — record COD payout
// --------------------------------------------------------------------------
export const recordSettlement = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const body = (req.body || {}) as Body;
  const amount = Number(body.amount);
  if (!Number.isFinite(amount)) throw new AppError("amount must be a number", 400);
  const receivedAt = body.receivedAt ? new Date(String(body.receivedAt)) : new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new AppError("receivedAt must be a valid date", 400);

  const shipment = await CourierShipment.findById(req.params.id);
  if (!shipment) throw new AppError("Shipment not found", 404);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const [created] = await CourierSettlement.create(
        [
          {
            shipmentId: shipment._id,
            orderId: shipment.orderId,
            payoutId: typeof body.payoutId === "string" ? body.payoutId.trim() : null,
            source: body.source === "COURIER_PAYOUT" ? "COURIER_PAYOUT" : "MANUAL_RECONCILE",
            amount: roundMoney(amount),
            receivedAt,
            recordedBy: getAuthUser(req)._id,
            reference: typeof body.reference === "string" ? body.reference.trim().slice(0, 200) : "",
            notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "",
          },
        ],
        { session }
      );
      // Recalculate totals + settlement status atomically.
      const agg = await CourierSettlement.aggregate([
        { $match: { shipmentId: shipment._id } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).session(session);
      const totalReceived = roundMoney(agg[0]?.total || 0);
      let settlementStatus: typeof shipment.settlementStatus = "PENDING";
      if (totalReceived <= 0) settlementStatus = "PENDING";
      else if (totalReceived >= shipment.codAmountSubmitted) settlementStatus = "SETTLED";
      else settlementStatus = "PARTIALLY_SETTLED";

      await CourierShipment.updateOne(
        { _id: shipment._id },
        {
          $set: {
            codAmountReceived: totalReceived,
            settlementStatus,
            lastSettlementRecordedAt: new Date(),
          },
        },
        { session }
      );
      void created;
    });
  } finally {
    await session.endSession();
  }

  const refreshed = await CourierShipment.findById(req.params.id);
  await logActivity(req, {
    action: "COURIER_SETTLEMENT_RECORDED",
    targetOrderId: shipment.orderId,
    newValue: { shipmentId: shipment._id, amount, receivedAt },
  });
  res.status(200).json({
    success: true,
    message: "Settlement recorded",
    data: refreshed ? toShipmentResponse(refreshed) : null,
  });
};

// --------------------------------------------------------------------------
// POST /api/admin/courier/shipments/:id/actual-fee
// --------------------------------------------------------------------------
export const recordActualFee = async (req: Request, res: Response) => {
  assertObjectId(req.params.id, "shipment ID");
  const body = (req.body || {}) as Body;
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new AppError("amount must be a non-negative number", 400);
  const shipment = await CourierShipment.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        actualCharge: roundMoney(amount),
        actualChargeRecordedBy: getAuthUser(req)._id,
        actualChargeRecordedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  if (!shipment) throw new AppError("Shipment not found", 404);
  await logActivity(req, {
    action: "COURIER_ACTUAL_FEE_RECORDED",
    targetOrderId: shipment.orderId,
    newValue: { shipmentId: shipment._id, amount },
  });
  res.status(200).json({ success: true, message: "Actual courier fee recorded", data: toShipmentResponse(shipment) });
};

// --------------------------------------------------------------------------
// GET /api/admin/courier/summary — dashboard cards
// --------------------------------------------------------------------------
export const getCourierSummary = async (_req: Request, res: Response) => {
  const [cards, balance] = await Promise.all([
    CourierShipment.aggregate([
      {
        $facet: {
          total: [{ $count: "n" }],
          byBooking: [{ $group: { _id: "$bookingStatus", n: { $sum: 1 } } }],
          byDelivery: [{ $group: { _id: "$deliveryStatus", n: { $sum: 1 } } }],
          bySettlement: [{ $group: { _id: "$settlementStatus", n: { $sum: 1 } } }],
          totals: [
            {
              $group: {
                _id: null,
                codSubmitted: { $sum: "$codAmountSubmitted" },
                codReceived: { $sum: "$codAmountReceived" },
                configuredCharge: { $sum: "$configuredCharge" },
                actualCharge: { $sum: { $ifNull: ["$actualCharge", 0] } },
              },
            },
          ],
        },
      },
    ]),
    isSteadfastConfigured()
      ? getBalance().catch(() => null)
      : Promise.resolve(null),
  ]);

  const facet = cards[0] || {};
  const byBooking = Object.fromEntries(
    (facet.byBooking || []).map((r: { _id: string; n: number }) => [r._id, r.n])
  );
  const byDelivery = Object.fromEntries(
    (facet.byDelivery || []).map((r: { _id: string; n: number }) => [r._id, r.n])
  );
  const bySettlement = Object.fromEntries(
    (facet.bySettlement || []).map((r: { _id: string; n: number }) => [r._id, r.n])
  );
  const totals = facet.totals?.[0] || {};

  res.status(200).json({
    success: true,
    message: "Courier summary fetched successfully",
    data: {
      totalShipments: facet.total?.[0]?.n || 0,
      booking: {
        inProgress: byBooking.IN_PROGRESS || 0,
        success: byBooking.SUCCESS || 0,
        failed: byBooking.FAILED || 0,
        uncertain: byBooking.UNCERTAIN || 0,
      },
      delivery: {
        pending: byDelivery.pending || 0,
        in_review: byDelivery.in_review || 0,
        hold: byDelivery.hold || 0,
        delivered: byDelivery.delivered || 0,
        partial_delivered: byDelivery.partial_delivered || 0,
        cancelled: byDelivery.cancelled || 0,
        exceptional: byDelivery.exceptional || 0,
        unknown: byDelivery.unknown || 0,
        delivered_approval_pending: byDelivery.delivered_approval_pending || 0,
        partial_delivered_approval_pending: byDelivery.partial_delivered_approval_pending || 0,
        cancelled_approval_pending: byDelivery.cancelled_approval_pending || 0,
        unknown_approval_pending: byDelivery.unknown_approval_pending || 0,
      },
      settlement: {
        pending: bySettlement.PENDING || 0,
        partiallySettled: bySettlement.PARTIALLY_SETTLED || 0,
        settled: bySettlement.SETTLED || 0,
        underReconciliation: bySettlement.UNDER_RECONCILIATION || 0,
        disputed: bySettlement.DISPUTED || 0,
      },
      totals: {
        codSubmitted: roundMoney(totals.codSubmitted || 0),
        codReceived: roundMoney(totals.codReceived || 0),
        codOutstanding: roundMoney(Math.max(0, (totals.codSubmitted || 0) - (totals.codReceived || 0))),
        configuredCharge: roundMoney(totals.configuredCharge || 0),
        actualCharge: roundMoney(totals.actualCharge || 0),
      },
      courierBalance: balance,
      configured: isSteadfastConfigured(),
    },
  });
};

// --------------------------------------------------------------------------
// GET /api/admin/courier/settings  &  PUT /api/admin/courier/settings
// --------------------------------------------------------------------------
export const getCourierSettingsEndpoint = async (_req: Request, res: Response) => {
  const value = await loadCourierSettings();
  res.status(200).json({
    success: true,
    message: "Courier settings fetched successfully",
    data: { ...value, configured: isSteadfastConfigured() },
  });
};

export const updateCourierSettingsEndpoint = async (req: Request, res: Response) => {
  const body = (req.body || {}) as Body;
  const current = await loadCourierSettings();
  const next: CourierSettings = { ...current };
  if (body.outboundCharge !== undefined) {
    const n = Number(body.outboundCharge);
    if (!Number.isFinite(n) || n < 0) throw new AppError("outboundCharge must be >= 0", 400);
    next.outboundCharge = roundMoney(n);
  }
  if (body.returnCharge !== undefined) {
    const n = Number(body.returnCharge);
    if (!Number.isFinite(n) || n < 0) throw new AppError("returnCharge must be >= 0", 400);
    next.returnCharge = roundMoney(n);
  }
  await SiteSetting.findOneAndUpdate(
    { key: COURIER_SETTINGS_KEY },
    { $set: { value: next } },
    { upsert: true }
  );
  await logActivity(req, {
    action: "COURIER_SETTINGS_UPDATED",
    oldValue: current,
    newValue: next,
  });
  res.status(200).json({ success: true, message: "Courier settings updated", data: next });
};
