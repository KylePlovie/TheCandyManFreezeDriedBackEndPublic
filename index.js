import express from "express";
import Stripe from "stripe";
import { google } from "googleapis";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { createRequire } from "node:module";
import bodyParser from "body-parser";

const require = createRequire(import.meta.url);
const serviceAccount = require("./serviceAccountKey.json");

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 5000;

// ---- Google Sheets service account credentials from .env ----
const googleSheetsCredentials = {
  type: "service_account",
  project_id: process.env.GOOGLE_CLOUD_PROJECT_ID,
  private_key_id: process.env.GOOGLE_CLOUD_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
};

// ---- Firebase Admin ----
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = getFirestore();

// ---- Google Sheets API ----
const sheets = google.sheets({
  version: "v4",
  auth: new google.auth.GoogleAuth({
    credentials: googleSheetsCredentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  }),
});

/* -----------------------------------------------------------
   Helpers
----------------------------------------------------------- */

//slug/id used in Firestore candies collection
function slugFromName(name = "") {
  return String(name).trim().toLowerCase().replace(/\s+/g, "-");
}

// Get a candies doc ref by item object.
// Prefer item.id if provided; otherwise derive from item.name.
function candyRefForItem(item) {
  const docId = item?.id || slugFromName(item?.name);
  return db.collection("candies").doc(docId);
}

// Read open/closed flag
async function isShopOpen() {
  const snap = await db.collection("config").doc("shop").get();
  return snap.exists ? !!snap.data().isOpen : true; // default open
}

// Append order to Google Sheets
async function appendOrderToSheet({ now, orderId, laneNumber, isPaid, items, customerDetails }) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const sheetName = "Orders";
    const orderData = [
      now.toLocaleString(),
      orderId,
      laneNumber,
      isPaid ? "Yes" : "No",
      items.map((item) => `${item.name} x${item.quantity}`).join(", "),
      customerDetails ? JSON.stringify(customerDetails) : "",
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: { values: [orderData] },
    });
  } catch (err) {
    console.error("❌ Google Sheets error:", err?.response?.data || err.message || err);
    throw new Error("Failed to write order to Google Sheet.");
  }
}

// Write order to Firestore, deduct stock (for paid orders)
async function handleOrder({ items, laneNumber, isPaid, customerDetails, orderId }) {
  const now = new Date();

  // 1) Save order
  try {
    const newOrderRef = db.collection("orders").doc(orderId);
    await newOrderRef.set({
      items,
      laneNumber,
      isPaid,
      customerDetails,
      timestamp: now,
    });
    console.log("✅ Order saved:", orderId);
  } catch (err) {
    console.error("❌ Firestore order write error:", err);
    throw new Error("Failed to save order to database.");
  }

  // 2) Deduct stock only when paid
  if (isPaid) {
    try {
      for (const item of items) {
        const ref = candyRefForItem(item); // id preferred; else name->slug
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) {
            console.warn(`⚠️ Candy not found: ${item.name}`);
            return;
          }
          const data = snap.data() || {};
          const current = Number(data.stock || 0);
          const newStock = current - Number(item.quantity || 0);
          if (newStock < 0) {
            console.warn(`⚠️ Not enough stock for ${item.name}, skipping update.`);
            return;
          }
          tx.update(ref, { stock: newStock });
        });
      }
    } catch (err) {
      console.error("❌ Stock deduction error:", err);
      // choose: throw or continue; we continue here so order still records
    }
  }

  // 3) Append to Google Sheet
  await appendOrderToSheet({ now, orderId, laneNumber, isPaid, items, customerDetails });
}

/* -----------------------------------------------------------
   Stripe Webhook — clears reservations on success
----------------------------------------------------------- */

// Stripe Webhook (raw parser only for this route!)
app.post("/stripe-webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`⚠️ Webhook verification failed: ${err.message}`);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Stripe checkout completed:", session.id);

    try {
      // Collect items from Stripe
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      const items = lineItems.data.map((li) => ({
        name: li.description,
        quantity: li.quantity,
      }));
      const laneNumber = session.metadata?.lane_number;
      const orderId = session.id;

      // Save order & deduct stock
      await handleOrder({
        items,
        laneNumber,
        isPaid: true,
        customerDetails: session.customer_details || null,
        orderId,
      });

      // CLEANUP: remove this session's reservations immediately
      await Promise.all(
        items.map(async (it) => {
          const ref = candyRefForItem(it);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            const data = snap.data() || {};
            const reservations = data.reservations || {};
            if (reservations[session.id]) {
              delete reservations[session.id];
              tx.update(ref, { reservations });
            }
          });
        })
      );

      res.status(200).json({ received: true });
    } catch (err) {
      console.error("❌ Stripe webhook handling error:", err);
      res.status(500).json({ error: "Failed to process order" });
    }
  } else {
    console.log(`Unhandled Stripe event: ${event.type}`);
    res.sendStatus(200);
  }
});

/* -----------------------------------------------------------
   General middleware (JSON AFTER webhook)
----------------------------------------------------------- */
app.use(cors());
app.use(express.json());

/* -----------------------------------------------------------
   Reserve Stock — checks shop is open; holds items 10 min
----------------------------------------------------------- */
app.post("/reserve-stock", async (req, res) => {
  try {
    // Hard-stop if closed
    if (!(await isShopOpen())) {
      return res.status(403).json({ error: "closed" });
    }

    const { items = [], sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const now = Date.now();
    const ttl = 10 * 60 * 1000; // 10 minutes

    await Promise.all(
      items.map(async (item) => {
        const ref = candyRefForItem(item);

        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const data = snap.data();
          if (!data) throw new Error(`Item not found: ${item.name || item.id}`);

          const reservations = { ...(data.reservations || {}) };
          let reservedCount = 0;

          // Clean up expired and compute reservedCount
          for (const key of Object.keys(reservations)) {
            const r = reservations[key];
            if (r && now - Number(r.timestamp || 0) < ttl) {
              reservedCount += Number(r.quantity || 0);
            } else {
              delete reservations[key];
            }
          }

          const available = Number(data.stock || 0) - reservedCount;
          const requested = Number(item.quantity || 0);
          if (available < requested) {
            throw new Error(`Not enough stock for ${item.name || item.id}`);
          }

          // Upsert this session's reservation
          const current = reservations[sessionId] || { quantity: 0, timestamp: now };
          reservations[sessionId] = {
            quantity: Number(current.quantity || 0) + requested,
            timestamp: now,
          };

          tx.update(ref, { reservations });
        });
      })
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Stock reservation error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

/* -----------------------------------------------------------
   Release Reservation — cancel/abandon path
----------------------------------------------------------- */
app.post("/release-reservation", async (req, res) => {
  const { items = [], sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  try {
    await Promise.all(
      items.map(async (item) => {
        const ref = candyRefForItem(item);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() || {};
          const reservations = data.reservations || {};
          if (reservations[sessionId]) {
            delete reservations[sessionId];
            tx.update(ref, { reservations });
          }
        });
      })
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Release reservation error:", err);
    res.status(500).json({ error: "Failed to release reservations" });
  }
});

/* -----------------------------------------------------------
   Pay-at-Table Orders — checks shop is open
----------------------------------------------------------- */
app.post("/send-order", async (req, res) => {
  try {
    if (!(await isShopOpen())) {
      return res.status(403).json({ error: "closed" });
    }

    const { items = [], laneNumber } = req.body;
    if (!Array.isArray(items) || !laneNumber) {
      return res.status(400).json({ error: "Missing items or laneNumber" });
    }

    // Prepare refs once
    const refs = items.map((it) => candyRefForItem(it));
    const now = Date.now();
    const ttl = 10 * 60 * 1000; // reservations valid for 10 minutes

    // Transaction: read ALL items, verify availability, then update all
    await db.runTransaction(async (tx) => {
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));

      // First pass: verify all availability
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const snap = snaps[i];
        if (!snap.exists) throw new Error(`Item not found: ${it.name || it.id}`);

        const data = snap.data() || {};
        const reservations = { ...(data.reservations || {}) };

        // Count only non-expired reservations
        let reservedCount = 0;
        for (const key of Object.keys(reservations)) {
          const r = reservations[key];
          if (r && now - Number(r.timestamp || 0) < ttl) {
            reservedCount += Number(r.quantity || 0);
          } else {
            // Clean expired reservation entries
            delete reservations[key];
          }
        }

        const stock = Number(data.stock || 0);
        const available = stock - reservedCount;
        const requested = Number(it.quantity || 0);

        if (available < requested) {
          throw new Error(`Not enough stock for ${it.name || it.id}`);
        }
      }

      // Second pass: apply all updates (decrement stock & save cleaned reservations)
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const snap = snaps[i];
        const data = snap.data() || {};
        const reservations = { ...(data.reservations || {}) };

        // Re-clean in case we want to persist cleaned reservations
        for (const key of Object.keys(reservations)) {
          const r = reservations[key];
          if (!r || now - Number(r.timestamp || 0) >= ttl) delete reservations[key];
        }

        const newStock = Number(data.stock || 0) - Number(it.quantity || 0);
        tx.update(refs[i], { stock: newStock, reservations });
      }
    });

    // If we got here, stock was decremented. Now record the order.
    const orderId = db.collection("orders").doc().id;
    await handleOrder({
      items,
      laneNumber,
      isPaid: false,
      customerDetails: null,
      orderId,
    });

    res.status(200).json({ message: "Order received and saved" });
  } catch (err) {
    console.error("❌ send-order error:", err);
    res.status(400).json({ error: err.message });
  }
});

/* -----------------------------------------------------------
   Stripe Checkout Session
----------------------------------------------------------- */
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!(await isShopOpen())) {
      return res.status(403).json({ error: "closed" });
    }

    const { items = [], lane } = req.body;

    const lineItems = items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: { name: item.name },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: Number(item.quantity),
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: "https://thecandymanfreezedried.com/success",
      cancel_url: "https://thecandymanfreezedried.com/bowling-order",
      metadata: {
        lane_number: lane,
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Stripe checkout session error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* -----------------------------------------------------------
   Start server
----------------------------------------------------------- */
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
