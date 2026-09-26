// Single source of truth for permissions and default roles.
// To add a new permission: add it here and restart the server (it is seeded automatically).

const PERMISSION_GROUPS: Record<string, string[]> = {
  dashboard: ["view"],
  users: ["view", "create", "update", "delete", "changeRole"],
  roles: ["view", "create", "update", "delete", "status"],
  permissions: ["view"],
  activityLogs: ["view"],
  products: ["view", "create", "update", "delete"],
  categories: ["view", "create", "update", "delete"],
  brands: ["view", "create", "update", "delete"],
  banners: ["view", "create", "update", "delete"],
  inventory: ["view", "create", "update"],
  // orders.view = own orders (customers); orders.viewAll = every customer's orders (admin panel)
  orders: ["view", "create", "update", "delete", "viewAll", "status", "paymentStatus"],
  cart: ["manage"],
  payments: ["view", "update"],
  invoices: ["view", "create"],
  customers: ["view", "update"],
  sales: ["view"],
  reports: ["view"],
  coupons: ["view", "create", "update", "delete"],
  reviews: ["view", "create", "update", "delete"],
  contactMessages: ["view", "update", "delete"],
  settings: ["view", "update"],
  profile: ["view", "update"],
  wishlist: ["manage"],
};

const PERMISSIONS = Object.entries(PERMISSION_GROUPS).flatMap(
  ([module, actions]) =>
    actions.map((action) => ({
      name: `${module}.${action}`,
      module,
      action,
      description: `${action} ${module}`,
    }))
);

const PERMISSION_NAMES = PERMISSIONS.map((p) => p.name);

// Role names used to identify special roles (never for authorization checks)
const ROLES = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  SALESMAN: "Salesman",
  CUSTOMER: "Customer",
} as const;

interface DefaultRole {
  name: string;
  description: string;
  isProtected: boolean;
  permissions: string[];
}

// Expand "products.*" into every products permission; "*" means all permissions
const expandPermissions = (patterns: string[]): string[] =>
  [
    ...new Set(
      patterns.flatMap((pattern: string) => {
        if (pattern === "*") return PERMISSION_NAMES;
        if (pattern.endsWith(".*")) {
          const module = pattern.slice(0, -2);
          return PERMISSION_NAMES.filter((name) => name.startsWith(`${module}.`));
        }
        return [pattern];
      })
    ),
  ];

const DEFAULT_ROLES: DefaultRole[] = [
  {
    name: ROLES.ADMIN,
    description: "Full access to every feature",
    isProtected: true,
    permissions: expandPermissions(["*"]),
  },
  {
    name: ROLES.MANAGER,
    description: "Manages products, inventory, orders and business data",
    isProtected: false,
    permissions: expandPermissions([
      "dashboard.view",
      "products.*",
      "categories.*",
      "brands.*",
      "inventory.*",
      "orders.view",
      "orders.viewAll",
      "orders.update",
      "customers.view",
      "sales.view",
      "reports.view",
    ]),
  },
  {
    name: ROLES.SALESMAN,
    description: "Handles sales and customer orders",
    isProtected: false,
    permissions: expandPermissions([
      "dashboard.view",
      "products.view",
      "customers.view",
      "orders.view",
      "orders.viewAll",
      "orders.create",
      "orders.update",
      "sales.view",
    ]),
  },
  {
    name: ROLES.CUSTOMER,
    description: "Default role for registered customers",
    isProtected: true,
    permissions: expandPermissions([
      "products.view",
      "cart.manage",
      "orders.create",
      "orders.view",
      "profile.view",
      "profile.update",
      "reviews.create",
      "wishlist.manage",
    ]),
  },
];

export {
  PERMISSIONS,
  PERMISSION_NAMES,
  ROLES,
  DEFAULT_ROLES,
};