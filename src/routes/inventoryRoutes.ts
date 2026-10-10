import express from "express";
import {
  getInventorySummary,
  listInventory,
  getProductInventory,
  updateProductInventory,
  setProductStock,
  adjustStock,
  recordDamage,
  recordReturn,
  listMovements,
  listProductMovements,
  stockMovementTypes,
  lowStockReport,
  outOfStockReport,
  profitReport,
  purchaseReport,
  valuationReport,
  listStockRequests,
  updateStockRequest,
  deleteStockRequest,
} from "../controllers/inventoryController";
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "../controllers/supplierController";
import {
  listShipments,
  getShipment,
  createShipment,
  updateShipment,
  deleteShipment,
  receiveShipment,
} from "../controllers/shipmentController";
import { authenticate, requirePermission } from "../middleware/auth";

const router = express.Router();

router.use(authenticate);

// Summary + table
router.get("/summary", requirePermission("inventory.view"), getInventorySummary);
router.get("/", requirePermission("inventory.view"), listInventory);

// Reports (defined before /:productId so they are not swallowed by the dynamic route)
router.get("/reports/low-stock", requirePermission("inventory.view"), lowStockReport);
router.get("/reports/out-of-stock", requirePermission("inventory.view"), outOfStockReport);
router.get("/reports/profit", requirePermission("inventory.view"), profitReport);
router.get("/reports/purchases", requirePermission("inventory.view"), purchaseReport);
router.get("/reports/valuation", requirePermission("inventory.view"), valuationReport);

// Movements
router.get("/movements", requirePermission("inventory.view"), listMovements);
router.get("/movements/types", requirePermission("inventory.view"), stockMovementTypes);

// Mutations
router.post("/adjust", requirePermission("inventory.adjust"), adjustStock);
router.post("/damage", requirePermission("inventory.adjust"), recordDamage);
router.post("/return", requirePermission("inventory.adjust"), recordReturn);

// Suppliers (nested under inventory for a single dashboard surface)
router.get("/suppliers", requirePermission("suppliers.view"), listSuppliers);
router.post("/suppliers", requirePermission("suppliers.create"), createSupplier);
router.get("/suppliers/:id", requirePermission("suppliers.view"), getSupplier);
router.put("/suppliers/:id", requirePermission("suppliers.update"), updateSupplier);
router.delete("/suppliers/:id", requirePermission("suppliers.delete"), deleteSupplier);

// Shipments
router.get("/shipments", requirePermission("shipments.view"), listShipments);
router.post("/shipments", requirePermission("shipments.create"), createShipment);
router.get("/shipments/:id", requirePermission("shipments.view"), getShipment);
router.put("/shipments/:id", requirePermission("shipments.update"), updateShipment);
router.delete("/shipments/:id", requirePermission("shipments.delete"), deleteShipment);
router.post("/shipments/:id/receive", requirePermission("shipments.receive"), receiveShipment);

// Stock requests
router.get("/stock-requests", requirePermission("stockRequests.view"), listStockRequests);
router.put("/stock-requests/:id", requirePermission("stockRequests.update"), updateStockRequest);
router.delete("/stock-requests/:id", requirePermission("stockRequests.delete"), deleteStockRequest);

// Per-product routes (dynamic — keep LAST)
router.get("/:productId/movements", requirePermission("inventory.view"), listProductMovements);
router.get("/:productId", requirePermission("inventory.view"), getProductInventory);
router.put("/:productId", requirePermission("inventory.update"), updateProductInventory);
router.patch("/:productId/stock", requirePermission("inventory.update"), setProductStock);

export default router;
