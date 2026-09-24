// Admin dashboard pages and the permission needed to see each one.
// The frontend uses the filtered list from /api/auth/me to build the sidebar.
// Hiding a menu item is only for UX: every API is still protected on the backend.

const DASHBOARD_PERMISSION = "dashboard.view";

export interface MenuItem {
  key: string;
  label: string;
  path: string;
  permission: string;
}

const DASHBOARD_MENU: MenuItem[] = [
  { key: "dashboard", label: "Dashboard", path: "/admin-dashboard/dashboard", permission: "dashboard.view" },
  { key: "categories", label: "Categories", path: "/admin-dashboard/categories", permission: "categories.view" },
  { key: "products", label: "Products", path: "/admin-dashboard/products", permission: "products.view" },
  { key: "orders", label: "Orders", path: "/admin-dashboard/orders", permission: "orders.viewAll" },
  { key: "payments", label: "Payments", path: "/admin-dashboard/payments", permission: "payments.view" },
  { key: "invoices", label: "Invoices", path: "/admin-dashboard/invoices", permission: "invoices.view" },
  { key: "users", label: "Users", path: "/admin-dashboard/users", permission: "users.view" },
  { key: "contactMessages", label: "Contact Messages", path: "/admin-dashboard/contact-messages", permission: "contactMessages.view" },
  { key: "coupons", label: "Coupons", path: "/admin-dashboard/coupons", permission: "coupons.view" },
  { key: "reviews", label: "Reviews", path: "/admin-dashboard/reviews", permission: "reviews.view" },
];

// Users without dashboard.view (e.g. customers) get no dashboard menu at all
const getDashboardMenu = (permissionSet: Set<string>): MenuItem[] =>
  permissionSet.has(DASHBOARD_PERMISSION)
    ? DASHBOARD_MENU.filter((item) => permissionSet.has(item.permission))
    : [];

export { DASHBOARD_MENU, getDashboardMenu };