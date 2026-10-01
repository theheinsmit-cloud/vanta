const STATUSES = [
  { key: "new", label: "New" },
  { key: "artwork_check", label: "Artwork Check" },
  { key: "ready_for_production", label: "Ready for Production" },
  { key: "in_production", label: "In Production" },
  { key: "ready_to_ship", label: "Ready to Ship" },
  { key: "shipped", label: "Shipped" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "refunded", label: "Refunded" }
];
const STATUS_KEYS = STATUSES.map((s) => s.key);
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
const PIPELINE = ["new", "artwork_check", "ready_for_production", "in_production", "ready_to_ship", "shipped", "completed"];

const LAYOUT_PANELS = { single: 1, duo: 2, trio: 3, quad: 4 };
const LAYOUT_LABEL = { single: "Single", duo: "Duo", trio: "Trio", quad: "Quad" };
// Layouts the Create page sells. Each has its own price per panel (sliding scale), stored as settings price_<key>_cents.
const PRICED_LAYOUTS = ["single", "duo", "quad"];

const EXPENSE_CATEGORIES = [
  "Equipment", "Materials/Stock", "Printing", "Packaging", "Shipping/Courier",
  "Software/Subscriptions", "Marketing", "Payment Fees", "Other"
];
// business = startup / overhead spend (heat press, software...). production = variable spend on making orders (stock, printing...).
const EXPENSE_TYPES = ["business", "production"];

const PAYMENT_LABEL = { pending: "Pending", paid: "Paid", partially_refunded: "Partially refunded", refunded: "Refunded" };

module.exports = { STATUSES, STATUS_KEYS, STATUS_LABEL, PIPELINE, LAYOUT_PANELS, LAYOUT_LABEL, PRICED_LAYOUTS, EXPENSE_CATEGORIES, EXPENSE_TYPES, PAYMENT_LABEL };
