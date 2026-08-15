import { useState, useEffect, useCallback, Fragment } from "react";
import {
  Beef, Scale, Users, ClipboardList, Receipt, Plus, Trash2, Download,
  AlertTriangle, Loader2, Check, FileDown, RefreshCw,
  PackagePlus, PenLine, History, ShieldCheck, UserCog,
  ChevronDown, ChevronRight, CheckCircle2, Circle, MessageSquare
} from "lucide-react";
import { supabase } from "./supabaseClient";

// ---------- order fulfillment checklist ----------
const ORDER_STAGES = [
  { key: "received", label: "Received" },
  { key: "entered", label: "Entered" },
  { key: "fulfilled", label: "Fulfilled" },
  { key: "invoiced", label: "Invoiced" },
];

// ---------- constants ----------
const MARGIN_TIERS = [10, 15, 20, 25, 30];
const LOW_STOCK = 15;

// ---------- formatting helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const money = (n) => { const v = Number(n); return isFinite(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "$0.00"; };
const pct = (n) => { const v = Number(n); return isFinite(v) ? v.toFixed(1) + "%" : "0.0%"; };
const lb = (n) => { const v = Number(n); return isFinite(v) ? v.toFixed(2) : "0.00"; };
const todayISO = () => new Date().toISOString().slice(0, 10);
const tierPrice = (cost, tierPct) => { const c = Number(cost) || 0; return tierPct >= 100 ? 0 : c / (1 - tierPct / 100); };
const weightedAvg = (onHandQty, avgCost, recvQty, recvCost) => {
  const oh = Number(onHandQty) || 0, ac = Number(avgCost) || 0, rq = Number(recvQty) || 0, rc = Number(recvCost) || 0;
  const total = oh + rq;
  return total <= 0 ? 0 : (oh * ac + rq * rc) / total;
};

// ---------- storage layer: one Postgres row per record (Supabase), so
// concurrent edits to different items/orders/customers never clobber
// each other. Each row is {id, data: <the record as JSON>, updated_at}. ----------
async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function loadCollection(table) {
  try {
    const { data, error } = await withRetry(() => supabase.from(table).select("data"));
    if (error) throw error;
    return (data || []).map((r) => r.data).filter(Boolean);
  } catch (e) { return []; }
}
async function saveRecord(table, record) {
  try {
    const { error } = await withRetry(() =>
      supabase.from(table).upsert({ id: record.id, data: record, updated_at: new Date().toISOString() })
    );
    return !error;
  } catch (e) { return false; }
}
async function deleteRecord(table, id) {
  try {
    const { error } = await withRetry(() => supabase.from(table).delete().eq("id", id));
    return error ? null : true;
  } catch (e) { return null; }
}
// fetch the freshest copy of one record right before mutating it, to shrink the race window
async function getFresh(table, id) {
  try {
    const { data, error } = await withRetry(() =>
      supabase.from(table).select("data").eq("id", id).single()
    );
    if (error || !data) return null;
    return data.data;
  } catch (e) { return null; }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function csvEscape(val) {
  const s = String(val ?? "");
  return (s.includes(",") || s.includes('"') || s.includes("\n")) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function orderCSV(order) {
  const rows = [["Customer", "InvoiceNo", "InvoiceDate", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount"]];
  order.lines.forEach((l) => rows.push([order.customerName, order.invoiceNo, order.date, l.itemName, l.comment ? `${l.itemName} — ${l.comment}` : l.itemName, lb(l.qty), l.price.toFixed(2), (l.qty * l.price).toFixed(2)]));
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}
function ordersToCSV(orders) {
  const rows = [["Customer", "InvoiceNo", "InvoiceDate", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount"]];
  orders.forEach((o) => o.lines.forEach((l) => rows.push([o.customerName, o.invoiceNo, o.date, l.itemName, l.comment ? `${l.itemName} — ${l.comment}` : l.itemName, lb(l.qty), l.price.toFixed(2), (l.qty * l.price).toFixed(2)])));
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

// ---------- shell ----------
export default function MeatOrderSystem() {
  const [role, setRole] = useState("manager");
  const [tab, setTab] = useState("cutting");
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const [it, cu, or] = await Promise.all([loadCollection("items"), loadCollection("customers"), loadCollection("orders")]);
    setItems(it); setCustomers(cu);
    setOrders(or.sort((a, b) => (a.date < b.date ? 1 : -1)));
    setRefreshing(false);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const saved = localStorage.getItem("role-pref");
        if (saved) setRole(saved);
      } catch (e) {}
      await refreshAll();
      setLoaded(true);
    })();
  }, [refreshAll]);

  useEffect(() => {
    if (!loaded) return;
    setTab(role === "manager" ? "cutting" : "pricebook");
  }, [role, loaded]);

  const changeRole = async (r) => {
    setRole(r);
    try { localStorage.setItem("role-pref", r); } catch (e) {}
  };

  // ---- item mutations: always re-read the freshest copy right before writing ----
  const createItem = async (name, qty, cost, note) => {
    const record = { id: uid(), name, avgCost: Number(cost) || 0, onHandQty: Number(qty) || 0, history: [{ id: uid(), date: todayISO(), type: "receive", qty: Number(qty) || 0, cost: Number(cost) || 0, note: note || "Initial stock" }] };
    const ok = await saveRecord("items", record);
    if (!ok) { setError("Couldn't save the new item — try again."); return; }
    setItems((prev) => [...prev, record]);
  };

  const receiveStock = async (itemId, qty, cost, note) => {
    const fresh = await getFresh("items", itemId);
    if (!fresh) { setError("That item couldn't be found — it may have been deleted. Refreshing…"); refreshAll(); return; }
    const newAvg = weightedAvg(fresh.onHandQty, fresh.avgCost, qty, cost);
    const updated = { ...fresh, avgCost: newAvg, onHandQty: (Number(fresh.onHandQty) || 0) + Number(qty), history: [{ id: uid(), date: todayISO(), type: "receive", qty: Number(qty), cost: Number(cost), note: note || "Manual receive" }, ...(fresh.history || [])] };
    const ok = await saveRecord("items", updated);
    if (!ok) { setError("Couldn't save the receiving transaction — try again."); return; }
    setItems((prev) => prev.map((i) => (i.id === itemId ? updated : i)));
  };

  const padCost = async (itemId, newCost) => {
    const fresh = await getFresh("items", itemId);
    if (!fresh) { setError("That item couldn't be found — it may have been deleted. Refreshing…"); refreshAll(); return; }
    const updated = { ...fresh, avgCost: Number(newCost), history: [{ id: uid(), date: todayISO(), type: "pad", qty: 0, cost: Number(newCost), note: "Manual landed cost override" }, ...(fresh.history || [])] };
    const ok = await saveRecord("items", updated);
    if (!ok) { setError("Couldn't save the cost override — try again."); return; }
    setItems((prev) => prev.map((i) => (i.id === itemId ? updated : i)));
  };

  const applyCounts = async (rows) => {
    const results = await Promise.all(rows.map(async (row) => {
      if (row.itemId) {
        const fresh = await getFresh("items", row.itemId);
        if (!fresh) return null;
        const updated = { ...fresh, onHandQty: row.newQty, history: [{ id: uid(), date: todayISO(), type: "count", qty: row.newQty, cost: fresh.avgCost, note: `Count upload (was ${lb(fresh.onHandQty)} lb)` }, ...(fresh.history || [])] };
        return (await saveRecord("items", updated)) ? updated : null;
      } else {
        const record = { id: uid(), name: row.name, avgCost: 0, onHandQty: row.newQty, history: [{ id: uid(), date: todayISO(), type: "count", qty: row.newQty, cost: 0, note: "Created via count upload — set landed cost" }] };
        return (await saveRecord("items", record)) ? record : null;
      }
    }));
    const succeeded = results.filter(Boolean);
    if (succeeded.length < rows.length) setError(`${rows.length - succeeded.length} row(s) in the count upload failed to save — check Inventory and retry those.`);
    setItems((prev) => {
      const byId = Object.fromEntries(prev.map((i) => [i.id, i]));
      succeeded.forEach((r) => { byId[r.id] = r; });
      return Object.values(byId);
    });
  };

  const deleteItem = async (id) => {
    const ok = await deleteRecord("items", id);
    if (ok == null) { setError("Couldn't delete the item — try again."); return; }
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  // ---- customers ----
  const createCustomer = async (c) => {
    const record = { id: uid(), ...c };
    const ok = await saveRecord("customers", record);
    if (!ok) { setError("Couldn't save the customer — try again."); return; }
    setCustomers((prev) => [...prev, record]);
  };
  const deleteCustomer = async (id) => {
    const ok = await deleteRecord("customers", id);
    if (ok == null) { setError("Couldn't delete the customer — try again."); return; }
    setCustomers((prev) => prev.filter((c) => c.id !== id));
  };

  // ---- orders: decrement each affected item from its freshest state, then write the order ----
  const saveOrder = async (order) => {
    const itemUpdates = await Promise.all(order.lines.map(async (line) => {
      const fresh = await getFresh("items", line.itemId);
      if (!fresh) return null;
      const updated = { ...fresh, onHandQty: (Number(fresh.onHandQty) || 0) - line.qty, history: [{ id: uid(), date: todayISO(), type: "sale", qty: -line.qty, cost: fresh.avgCost, note: `Sold on ${order.invoiceNo}` }, ...(fresh.history || [])] };
      return (await saveRecord("items", updated)) ? updated : null;
    }));
    const failedItems = itemUpdates.filter((u) => u === null).length;
    const ok = await saveRecord("orders", order);
    if (!ok) { setError("The order failed to save. Please retry — don't assume inventory was adjusted."); return false; }
    if (failedItems > 0) setError(`Order saved, but ${failedItems} item(s) didn't get their inventory decremented — check Inventory manually.`);
    setOrders((prev) => [order, ...prev]);
    setItems((prev) => {
      const byId = Object.fromEntries(prev.map((i) => [i.id, i]));
      itemUpdates.filter(Boolean).forEach((u) => { byId[u.id] = u; });
      return Object.values(byId);
    });
    return true;
  };
  const markExported = async (order) => {
    const updated = { ...order, exported: true };
    const ok = await saveRecord("orders", updated);
    if (!ok) { setError("Couldn't mark the invoice as exported — try again."); return; }
    setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
  };
  const toggleOrderStage = async (order, stageKey) => {
    const fresh = await getFresh("orders", order.id);
    const base = fresh || order;
    const currentStages = base.stages || { received: false, entered: false, fulfilled: false, invoiced: false };
    const updated = { ...base, stages: { ...currentStages, [stageKey]: !currentStages[stageKey] } };
    const ok = await saveRecord("orders", updated);
    if (!ok) { setError("Couldn't update the order checklist — try again."); return; }
    setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
  };
  const deleteOrder = async (id) => {
    const ok = await deleteRecord("orders", id);
    if (ok == null) { setError("Couldn't delete the order — try again."); return; }
    setOrders((prev) => prev.filter((o) => o.id !== id));
  };

  const managerTabs = [
    { id: "cutting", label: "Yield Calculator", icon: Beef },
    { id: "inventory", label: "Inventory", icon: Scale },
    { id: "customers", label: "Customers", icon: Users },
    { id: "order", label: "New Order", icon: ClipboardList },
    { id: "orders", label: "Orders & Invoices", icon: Receipt },
  ];
  const repTabs = [
    { id: "pricebook", label: "Price Book", icon: Scale },
    { id: "order", label: "New Order", icon: ClipboardList },
    { id: "orders", label: "Orders & Invoices", icon: Receipt },
  ];
  const tabs = role === "manager" ? managerTabs : repTabs;

  return (
    <div style={{ background: "var(--paper)", minHeight: "100vh", fontFamily: "var(--font-body)", color: "var(--ink)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@500;700;900&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        :root {
          --paper: #ECEAE2; --paper-card: #F5F3EC; --ink: #2A2521; --ink-soft: #5B5548;
          --oxblood: #7A2E2A; --oxblood-dark: #5E211E; --brass: #A8752F; --brass-light: #C99B4A;
          --line: #CFC7B6; --green: #4A5D3A;
          --font-display: 'Roboto Slab', serif; --font-body: 'Inter', sans-serif; --font-mono: 'IBM Plex Mono', monospace;
        }
        .disp { font-family: var(--font-display); }
        .mono { font-family: var(--font-mono); }
        .tag-btn { font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.02em; border: 2px solid var(--ink); background: var(--paper-card); transition: transform 0.12s ease, background 0.12s ease; }
        .tag-btn:hover { transform: translateY(-1px); }
        .tag-btn-primary { background: var(--oxblood); color: var(--paper-card); border-color: var(--oxblood-dark); }
        .tag-btn-primary:hover { background: var(--oxblood-dark); }
        .stamp { border: 2px solid currentColor; border-radius: 4px; padding: 1px 8px; font-family: var(--font-mono); font-weight: 600; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; display: inline-block; }
        input, select, textarea { font-family: var(--font-body); background: #fff; border: 1.5px solid var(--line); border-radius: 3px; }
        input:focus, select:focus, textarea:focus { outline: 2px solid var(--brass); outline-offset: 1px; border-color: var(--brass); }
        table { border-collapse: collapse; }
        th { font-family: var(--font-mono); font-size: 0.65rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-soft); }
        td, th { border-bottom: 1px solid var(--line); }
        .role-pill { display: flex; border: 2px solid var(--ink); border-radius: 999px; overflow: hidden; }
        .role-pill button { font-family: var(--font-mono); font-weight: 700; font-size: 0.72rem; padding: 6px 14px; letter-spacing: 0.03em; }
      `}</style>

      <header style={{ borderBottom: "3px solid var(--ink)", background: "var(--paper-card)" }} className="px-4 py-4 sm:px-8 sm:py-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div style={{ background: "var(--oxblood)", color: "var(--paper-card)" }} className="p-2 rounded"><Beef size={24} /></div>
          <div>
            <h1 className="disp" style={{ fontWeight: 900, fontSize: "1.3rem", lineHeight: 1 }}>CUTTING ROOM LEDGER</h1>
            <p className="mono" style={{ fontSize: "0.68rem", color: "var(--ink-soft)", letterSpacing: "0.04em" }}>INVENTORY · MARGIN TIERS · ORDER ENTRY · QUICKBOOKS EXPORT</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refreshAll} title="Refresh from shared storage" className="p-2 rounded" style={{ border: "1.5px solid var(--line)" }}>
            {refreshing || !loaded ? <Loader2 className="animate-spin" size={16} color="var(--ink-soft)" /> : <RefreshCw size={16} color="var(--ink-soft)" />}
          </button>
          <div className="role-pill">
            <button onClick={() => changeRole("manager")} style={{ background: role === "manager" ? "var(--oxblood)" : "transparent", color: role === "manager" ? "var(--paper-card)" : "var(--ink)" }} className="flex items-center gap-1">
              <ShieldCheck size={13} /> Manager
            </button>
            <button onClick={() => changeRole("rep")} style={{ background: role === "rep" ? "var(--oxblood)" : "transparent", color: role === "rep" ? "var(--paper-card)" : "var(--ink)" }} className="flex items-center gap-1">
              <UserCog size={13} /> Sales Rep
            </button>
          </div>
        </div>
      </header>

      <p className="px-4 sm:px-8 py-1.5 text-xs mono" style={{ background: "#F4E4D8", color: "var(--ink-soft)" }}>
        This toggle just switches the view — it isn't a login. Anyone opening this app can switch roles.
      </p>

      {error && (
        <div style={{ background: "#F4E4D8", borderBottom: "1px solid var(--oxblood)" }} className="px-4 py-2 flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2"><AlertTriangle size={16} color="var(--oxblood)" />{error}</span>
          <button onClick={() => setError("")} style={{ color: "var(--ink-soft)" }} className="text-xs">dismiss</button>
        </div>
      )}

      <nav className="flex overflow-x-auto" style={{ borderBottom: "1.5px solid var(--ink)", background: "var(--paper)" }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-2 px-4 sm:px-6 py-3 whitespace-nowrap disp"
              style={{ fontWeight: 700, fontSize: "0.86rem", borderBottom: active ? "3px solid var(--oxblood)" : "3px solid transparent", color: active ? "var(--oxblood)" : "var(--ink-soft)", marginBottom: "-1.5px" }}>
              <Icon size={16} /> {t.label}
            </button>
          );
        })}
      </nav>

      <main className="px-4 py-6 sm:px-8 sm:py-8 max-w-6xl mx-auto">
        {!loaded ? (
          <div className="text-center py-16" style={{ color: "var(--ink-soft)" }}><Loader2 className="animate-spin mx-auto mb-2" size={22} />Loading…</div>
        ) : (
          <>
            {tab === "cutting" && role === "manager" && <YieldCalculator items={items} onCreateItem={createItem} onReceiveStock={receiveStock} />}
            {tab === "inventory" && role === "manager" && <Inventory items={items} onCreateItem={createItem} onReceiveStock={receiveStock} onPadCost={padCost} onApplyCounts={applyCounts} onDeleteItem={deleteItem} />}
            {tab === "pricebook" && role === "rep" && <PriceBook items={items} />}
            {tab === "customers" && role === "manager" && <Customers customers={customers} onCreate={createCustomer} onDelete={deleteCustomer} />}
            {tab === "order" && <NewOrder items={items} customers={customers} onSaveOrder={saveOrder} role={role} />}
            {tab === "orders" && <OrdersView orders={orders} onMarkExported={markExported} onToggleStage={toggleOrderStage} onDelete={deleteOrder} role={role} />}
          </>
        )}
      </main>
    </div>
  );
}

// ---------- Yield Calculator (manager) ----------
function YieldCalculator({ items, onCreateItem, onReceiveStock }) {
  const [primal, setPrimal] = useState({ name: "", cost: "", weight: "" });
  const [rows, setRows] = useState([]);
  const [rowForm, setRowForm] = useState({ name: "", yieldPct: "" });
  const [receiveOpen, setReceiveOpen] = useState(null);
  const [receiveForm, setReceiveForm] = useState({ mode: "new", itemId: "", newName: "", qty: "", cost: "" });

  const rawCost = primal.weight > 0 ? (Number(primal.cost) || 0) / Number(primal.weight) : 0;

  const addRow = () => {
    if (!rowForm.name || !rowForm.yieldPct) return;
    setRows([...rows, { id: uid(), name: rowForm.name, yieldPct: Number(rowForm.yieldPct) }]);
    setRowForm({ name: "", yieldPct: "" });
  };
  const removeRow = (id) => setRows(rows.filter((r) => r.id !== id));

  const openReceive = (row) => {
    const finished = rawCost / (row.yieldPct / 100);
    const qty = (Number(primal.weight) || 0) * (row.yieldPct / 100);
    const existing = items.find((i) => i.name.toLowerCase() === row.name.toLowerCase());
    setReceiveForm({ mode: existing ? "existing" : "new", itemId: existing ? existing.id : "", newName: row.name, qty: qty.toFixed(2), cost: finished.toFixed(2) });
    setReceiveOpen(row.id);
  };

  const confirmReceive = async () => {
    const qty = Number(receiveForm.qty), cost = Number(receiveForm.cost);
    if (!qty || !cost) return;
    if (receiveForm.mode === "existing" && receiveForm.itemId) {
      await onReceiveStock(receiveForm.itemId, qty, cost, "From yield calculator");
    } else if (receiveForm.newName) {
      await onCreateItem(receiveForm.newName, qty, cost, "From yield calculator");
    }
    setReceiveOpen(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>1. What did you buy?</h2>
        <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>The raw primal — total cost and total weight.</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input placeholder="Primal name (e.g. Beef Rib Primal)" value={primal.name} onChange={(e) => setPrimal({ ...primal, name: e.target.value })} className="px-3 py-2 flex-1" />
          <input placeholder="Total cost $" type="number" value={primal.cost} onChange={(e) => setPrimal({ ...primal, cost: e.target.value })} className="px-3 py-2 w-full sm:w-36 mono" />
          <input placeholder="Total weight lb" type="number" value={primal.weight} onChange={(e) => setPrimal({ ...primal, weight: e.target.value })} className="px-3 py-2 w-full sm:w-36 mono" />
        </div>
        {primal.weight > 0 && <p className="mono text-sm mt-3" style={{ color: "var(--brass)" }}>Raw material cost: {money(rawCost)}/lb</p>}
      </section>

      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>2. What did it yield?</h2>
        <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>Finished cost/lb = Raw cost/lb ÷ Yield %.</p>
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <input placeholder="Cut name (e.g. Ribeye)" value={rowForm.name} onChange={(e) => setRowForm({ ...rowForm, name: e.target.value })} className="px-3 py-2 flex-1" />
          <input placeholder="Yield %" type="number" value={rowForm.yieldPct} onChange={(e) => setRowForm({ ...rowForm, yieldPct: e.target.value })} className="px-3 py-2 w-full sm:w-28 mono" />
          <button onClick={addRow} className="tag-btn px-4 py-2 rounded flex items-center justify-center gap-1"><Plus size={16} /> Add cut</button>
        </div>

        {rows.length > 0 && (
          <div className="flex flex-col gap-3">
            {rows.map((row) => {
              const finished = rawCost > 0 && row.yieldPct > 0 ? rawCost / (row.yieldPct / 100) : 0;
              const qty = (Number(primal.weight) || 0) * (row.yieldPct / 100);
              const existing = items.find((i) => i.name.toLowerCase() === row.name.toLowerCase());
              return (
                <div key={row.id} style={{ border: "1px solid var(--line)", borderRadius: 4 }} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span style={{ fontWeight: 600 }}>{row.name}</span>
                      <span className="mono text-sm ml-2" style={{ color: "var(--ink-soft)" }}>
                        {money(rawCost)} ÷ {row.yieldPct}% → <span style={{ color: "var(--brass)", fontWeight: 600 }}>{money(finished)}/lb</span> · {lb(qty)} lb
                      </span>
                      {existing && <span className="stamp ml-2" style={{ color: "var(--green)" }}>existing item</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => openReceive(row)} className="tag-btn tag-btn-primary px-3 py-1.5 rounded flex items-center gap-1 text-xs"><PackagePlus size={14} /> Receive into inventory</button>
                      <button onClick={() => removeRow(row.id)} style={{ color: "var(--ink-soft)" }}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {receiveOpen === row.id && (
                    <div style={{ borderTop: "1px dashed var(--line)" }} className="mt-3 pt-3 flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                      <select value={receiveForm.mode === "existing" ? receiveForm.itemId : "new"} onChange={(e) => {
                        if (e.target.value === "new") setReceiveForm({ ...receiveForm, mode: "new", itemId: "" });
                        else setReceiveForm({ ...receiveForm, mode: "existing", itemId: e.target.value });
                      }} className="px-2 py-1.5 text-sm">
                        <option value="new">+ New item: {receiveForm.newName}</option>
                        {items.map((i) => <option key={i.id} value={i.id}>Add to existing: {i.name}</option>)}
                      </select>
                      <input type="number" value={receiveForm.qty} onChange={(e) => setReceiveForm({ ...receiveForm, qty: e.target.value })} className="px-2 py-1.5 w-24 mono text-sm" placeholder="Qty lb" />
                      <input type="number" value={receiveForm.cost} onChange={(e) => setReceiveForm({ ...receiveForm, cost: e.target.value })} className="px-2 py-1.5 w-28 mono text-sm" placeholder="Cost/lb" />
                      <button onClick={confirmReceive} className="tag-btn tag-btn-primary px-3 py-1.5 rounded flex items-center gap-1 text-xs"><Check size={14} /> Confirm</button>
                      <button onClick={() => setReceiveOpen(null)} className="text-xs" style={{ color: "var(--ink-soft)" }}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- Inventory (manager) ----------
function Inventory({ items, onCreateItem, onReceiveStock, onPadCost, onApplyCounts, onDeleteItem }) {
  const [newItem, setNewItem] = useState({ name: "", qty: "", cost: "" });
  const [openRow, setOpenRow] = useState(null);
  const [form, setForm] = useState({ qty: "", cost: "" });
  const [historyOpen, setHistoryOpen] = useState({});
  const [countText, setCountText] = useState("");
  const [countPreview, setCountPreview] = useState(null);

  const addItem = async () => {
    if (!newItem.name) return;
    await onCreateItem(newItem.name, newItem.qty, newItem.cost, "Initial stock");
    setNewItem({ name: "", qty: "", cost: "" });
  };

  const openAction = (id, mode) => { setOpenRow({ id, mode }); setForm({ qty: "", cost: "" }); };

  const confirm = async () => {
    if (openRow.mode === "receive") {
      if (!form.qty || !form.cost) return;
      await onReceiveStock(openRow.id, Number(form.qty), Number(form.cost), "Manual receive");
    } else {
      if (form.cost === "") return;
      await onPadCost(openRow.id, Number(form.cost));
    }
    setOpenRow(null);
  };

  const parseCountText = (text) => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const rows = [];
    lines.forEach((line) => {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 2) return;
      const [name, qtyStr] = parts;
      const qty = Number(qtyStr);
      if (!name || isNaN(qty)) return;
      rows.push({ name, qty });
    });
    setCountPreview(rows.map((r) => {
      const existing = items.find((i) => i.name.toLowerCase() === r.name.toLowerCase());
      return { name: r.name, newQty: r.qty, itemId: existing ? existing.id : null, oldQty: existing ? existing.onHandQty : null };
    }));
  };
  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseCountText(String(ev.target.result || ""));
    reader.readAsText(file);
  };
  const applyCount = async () => {
    if (!countPreview) return;
    await onApplyCounts(countPreview);
    setCountPreview(null); setCountText("");
  };

  return (
    <div className="flex flex-col gap-6">
      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>Upload inventory count</h2>
        <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
          CSV or pasted lines of <span className="mono">Item name, Counted qty</span>. Sets on-hand quantity to match a physical count — doesn't touch landed cost. Sales against these items draw down from the new count in real time.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 items-start">
          <input type="file" accept=".csv,text/csv,text/plain" onChange={handleFile} className="text-sm" />
          <span className="text-xs" style={{ color: "var(--ink-soft)" }}>or paste below</span>
        </div>
        <textarea value={countText} onChange={(e) => setCountText(e.target.value)} placeholder={"Ribeye, 42.5\nStrip Loin, 18.0"} rows={3} className="w-full px-3 py-2 mt-2 mono text-sm" />
        <button onClick={() => parseCountText(countText)} className="tag-btn px-4 py-2 rounded flex items-center gap-1 mt-2 text-xs"><FileDown size={14} className="rotate-180" /> Preview</button>

        {countPreview && (
          <div style={{ borderTop: "1px dashed var(--line)" }} className="mt-4 pt-4">
            {countPreview.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--oxblood)" }}>Couldn't parse any rows — check the format (name, qty per line).</p>
            ) : (
              <>
                <table className="w-full text-sm mb-3">
                  <thead><tr><th className="text-left py-1 pr-3">Item</th><th className="text-right py-1 pr-3">Current</th><th className="text-right py-1 pr-3">New count</th><th className="text-left py-1">Status</th></tr></thead>
                  <tbody>
                    {countPreview.map((r, idx) => (
                      <tr key={idx}>
                        <td className="py-1 pr-3">{r.name}</td>
                        <td className="text-right py-1 pr-3 mono">{r.itemId ? lb(r.oldQty) : "—"}</td>
                        <td className="text-right py-1 pr-3 mono" style={{ fontWeight: 600 }}>{lb(r.newQty)}</td>
                        <td className="py-1"><span className="stamp" style={{ color: r.itemId ? "var(--green)" : "var(--brass)" }}>{r.itemId ? "match" : "new item"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center gap-2">
                  <button onClick={applyCount} className="tag-btn tag-btn-primary px-4 py-2 rounded flex items-center gap-1 text-xs"><Check size={14} /> Apply count</button>
                  <button onClick={() => setCountPreview(null)} className="text-xs" style={{ color: "var(--ink-soft)" }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>Add item directly</h2>
        <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>For stock that didn't come through the yield calculator.</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input placeholder="Item name" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} className="px-3 py-2 flex-1" />
          <input placeholder="Starting qty lb" type="number" value={newItem.qty} onChange={(e) => setNewItem({ ...newItem, qty: e.target.value })} className="px-3 py-2 w-full sm:w-36 mono" />
          <input placeholder="Landed cost/lb" type="number" value={newItem.cost} onChange={(e) => setNewItem({ ...newItem, cost: e.target.value })} className="px-3 py-2 w-full sm:w-32 mono" />
          <button onClick={addItem} className="tag-btn tag-btn-primary px-4 py-2 rounded flex items-center justify-center gap-1"><Plus size={16} /> Add</button>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="text-center py-10" style={{ color: "var(--ink-soft)" }}><Scale size={28} className="mx-auto mb-2" />No items yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }}>
            <thead>
              <tr>
                <th className="text-left py-2 px-3">Item</th>
                <th className="text-right py-2 px-3">On hand</th>
                <th className="text-right py-2 px-3">Landed cost/lb</th>
                {MARGIN_TIERS.map((t) => <th key={t} className="text-right py-2 px-3">{t}%</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const low = Number(i.onHandQty) <= LOW_STOCK;
                const open = openRow?.id === i.id;
                const hOpen = historyOpen[i.id];
                return (
                  <Fragment key={i.id}>
                    <tr>
                      <td className="py-2 px-3">{i.name}</td>
                      <td className="text-right py-2 px-3 mono" style={{ color: low ? "var(--oxblood)" : "var(--ink)" }}>{lb(i.onHandQty)}{low && <AlertTriangle size={12} className="inline ml-1 -mt-0.5" />}</td>
                      <td className="text-right py-2 px-3 mono">{money(i.avgCost)}</td>
                      {MARGIN_TIERS.map((t) => <td key={t} className="text-right py-2 px-3 mono">{money(tierPrice(i.avgCost, t))}</td>)}
                      <td className="py-2 px-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openAction(i.id, "receive")} title="Receive stock" style={{ color: "var(--green)" }}><PackagePlus size={15} /></button>
                          <button onClick={() => openAction(i.id, "pad")} title="Pad / override landed cost" style={{ color: "var(--brass)" }}><PenLine size={15} /></button>
                          <button onClick={() => setHistoryOpen((h) => ({ ...h, [i.id]: !hOpen }))} title="History" style={{ color: "var(--ink-soft)" }}><History size={15} /></button>
                          <button onClick={() => onDeleteItem(i.id)} title="Delete item" style={{ color: "var(--oxblood)" }}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={MARGIN_TIERS.length + 4} style={{ background: "#F4E4D8" }} className="p-3">
                          {openRow.mode === "receive" ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm" style={{ color: "var(--ink-soft)" }}>Receive stock —</span>
                              <input type="number" placeholder="Qty lb" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="px-2 py-1.5 w-24 mono text-sm" />
                              <input type="number" placeholder="Cost/lb" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className="px-2 py-1.5 w-28 mono text-sm" />
                              {form.qty && form.cost && <span className="text-xs mono" style={{ color: "var(--brass)" }}>new avg → {money(weightedAvg(i.onHandQty, i.avgCost, form.qty, form.cost))}/lb</span>}
                              <button onClick={confirm} className="tag-btn tag-btn-primary px-3 py-1.5 rounded text-xs flex items-center gap-1"><Check size={13} /> Confirm</button>
                              <button onClick={() => setOpenRow(null)} className="text-xs" style={{ color: "var(--ink-soft)" }}>Cancel</button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm" style={{ color: "var(--ink-soft)" }}>Override current landed cost —</span>
                              <input type="number" placeholder="New landed cost/lb" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className="px-2 py-1.5 w-28 mono text-sm" />
                              <button onClick={confirm} className="tag-btn tag-btn-primary px-3 py-1.5 rounded text-xs flex items-center gap-1"><Check size={13} /> Confirm</button>
                              <button onClick={() => setOpenRow(null)} className="text-xs" style={{ color: "var(--ink-soft)" }}>Cancel</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    {hOpen && (
                      <tr>
                        <td colSpan={MARGIN_TIERS.length + 4} className="p-3" style={{ background: "#fff" }}>
                          {(i.history || []).length === 0 ? <span className="text-xs" style={{ color: "var(--ink-soft)" }}>No history.</span> : (
                            <table className="w-full text-xs">
                              <thead><tr><th className="text-left py-1 pr-3">Date</th><th className="text-left py-1 pr-3">Type</th><th className="text-right py-1 pr-3">Qty</th><th className="text-right py-1 pr-3">Cost/lb</th><th className="text-left py-1">Note</th></tr></thead>
                              <tbody>
                                {i.history.map((h) => (
                                  <tr key={h.id}>
                                    <td className="py-1 pr-3 mono">{h.date}</td>
                                    <td className="py-1 pr-3"><span className="stamp" style={{ color: h.type === "pad" ? "var(--brass)" : h.type === "sale" ? "var(--oxblood)" : "var(--green)" }}>{h.type}</span></td>
                                    <td className="text-right py-1 pr-3 mono">{h.qty ? lb(h.qty) : "—"}</td>
                                    <td className="text-right py-1 pr-3 mono">{money(h.cost)}</td>
                                    <td className="py-1" style={{ color: "var(--ink-soft)" }}>{h.note}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Price Book (rep, read-only, no cost exposed) ----------
function PriceBook({ items }) {
  const [q, setQ] = useState("");
  const filtered = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-4">
      <input placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} className="px-3 py-2 w-full sm:w-72" />
      {filtered.length === 0 ? (
        <div className="text-center py-10" style={{ color: "var(--ink-soft)" }}><Scale size={28} className="mx-auto mb-2" />No items found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }}>
            <thead><tr><th className="text-left py-2 px-3">Item</th><th className="text-right py-2 px-3">On hand</th>{MARGIN_TIERS.map((t) => <th key={t} className="text-right py-2 px-3">{t}%</th>)}</tr></thead>
            <tbody>
              {filtered.map((i) => {
                const low = Number(i.onHandQty) <= LOW_STOCK;
                return (
                  <tr key={i.id}>
                    <td className="py-2 px-3">{i.name}</td>
                    <td className="text-right py-2 px-3 mono" style={{ color: low ? "var(--oxblood)" : "var(--ink)" }}>{lb(i.onHandQty)}{low && <AlertTriangle size={12} className="inline ml-1 -mt-0.5" />}</td>
                    {MARGIN_TIERS.map((t) => <td key={t} className="text-right py-2 px-3 mono">{money(tierPrice(i.avgCost, t))}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Customers ----------
function Customers({ customers, onCreate, onDelete }) {
  const [form, setForm] = useState({ name: "", company: "", email: "" });
  const add = async () => { if (!form.name) return; await onCreate(form); setForm({ name: "", company: "", email: "" }); };
  return (
    <div className="flex flex-col gap-6">
      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>Add a customer</h2>
        <div className="flex flex-col sm:flex-row gap-3 mt-3">
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="px-3 py-2 flex-1" />
          <input placeholder="Company (optional)" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="px-3 py-2 flex-1" />
          <input placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="px-3 py-2 flex-1" />
          <button onClick={add} className="tag-btn tag-btn-primary px-4 py-2 rounded flex items-center justify-center gap-1"><Plus size={16} /> Add</button>
        </div>
      </section>
      {customers.length === 0 ? (
        <div className="text-center py-10" style={{ color: "var(--ink-soft)" }}><Users size={28} className="mx-auto mb-2" />No customers yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }}>
            <thead><tr><th className="text-left py-2 px-3">Name</th><th className="text-left py-2 px-3">Company</th><th className="text-left py-2 px-3">Email</th><th></th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 px-3">{c.name}</td><td className="py-2 px-3">{c.company}</td><td className="py-2 px-3">{c.email}</td>
                  <td className="py-2 px-3 text-right"><button onClick={() => onDelete(c.id)} style={{ color: "var(--oxblood)" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- New Order ----------
function NewOrder({ items, customers, onSaveOrder, role }) {
  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState([]);
  const [lf, setLf] = useState({ itemId: "", qty: "", tier: 20, custom: "", useCustom: false });
  const [savedMsg, setSavedMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedItem = items.find((i) => i.id === lf.itemId);
  const previewPrice = selectedItem ? (lf.useCustom ? Number(lf.custom) || 0 : tierPrice(selectedItem.avgCost, lf.tier)) : 0;

  const addLine = () => {
    const it = items.find((i) => i.id === lf.itemId);
    if (!it || !lf.qty) return;
    const price = lf.useCustom ? Number(lf.custom) || 0 : tierPrice(it.avgCost, lf.tier);
    setLines([...lines, { id: uid(), itemId: it.id, itemName: it.name, qty: Number(lf.qty), price, cost: it.avgCost, tier: lf.useCustom ? null : lf.tier, comment: "" }]);
    setLf({ itemId: "", qty: "", tier: 20, custom: "", useCustom: false });
  };
  const removeLine = (id) => setLines(lines.filter((l) => l.id !== id));
  const updateLineComment = (id, comment) => setLines(lines.map((l) => (l.id === id ? { ...l, comment } : l)));

  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const totalCost = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  const marginDollar = subtotal - totalCost;
  const marginPct = subtotal > 0 ? (marginDollar / subtotal) * 100 : 0;

  const handleSave = async () => {
    const cust = customers.find((c) => c.id === customerId);
    if (!cust || lines.length === 0 || saving) return;
    setSaving(true);
    const invoiceNo = `INV-${todayISO().replace(/-/g, "")}-${uid().slice(0, 4).toUpperCase()}`;
    const order = { id: uid(), invoiceNo, date, customerId: cust.id, customerName: cust.name, lines, subtotal, totalCost, marginDollar, marginPct, exported: false, stages: { received: false, entered: false, fulfilled: false, invoiced: false } };
    const ok = await onSaveOrder(order);
    setSaving(false);
    if (ok) {
      setSavedMsg(`Saved as ${invoiceNo}.`);
      setLines([]); setCustomerId("");
      setTimeout(() => setSavedMsg(""), 5000);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <div className="flex flex-col sm:flex-row gap-3">
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="px-3 py-2 flex-1">
            <option value="">Select customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 mono" />
        </div>
        {customers.length === 0 && <p className="text-sm mt-2" style={{ color: "var(--oxblood)" }}>No customers yet — a manager can add one in the Customers tab.</p>}
      </section>

      <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="p-4 sm:p-5 rounded">
        <h2 className="disp" style={{ fontWeight: 700, fontSize: "1.05rem" }}>Add line item</h2>
        <div className="flex flex-col sm:flex-row gap-3 mt-3 flex-wrap">
          <select value={lf.itemId} onChange={(e) => setLf({ ...lf, itemId: e.target.value })} className="px-3 py-2 flex-1">
            <option value="">Select item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name} — {lb(i.onHandQty)} lb on hand</option>)}
          </select>
          <input placeholder="Qty lb" type="number" value={lf.qty} onChange={(e) => setLf({ ...lf, qty: e.target.value })} className="px-3 py-2 w-full sm:w-24 mono" />
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {MARGIN_TIERS.map((t) => (
            <button key={t} onClick={() => setLf({ ...lf, tier: t, useCustom: false })}
              className="tag-btn px-3 py-1.5 rounded text-xs"
              style={{ background: !lf.useCustom && lf.tier === t ? "var(--brass)" : "var(--paper-card)", color: !lf.useCustom && lf.tier === t ? "#fff" : "var(--ink)", borderColor: !lf.useCustom && lf.tier === t ? "var(--brass)" : "var(--ink)" }}>
              {t}% margin
            </button>
          ))}
          <button onClick={() => setLf({ ...lf, useCustom: true })} className="tag-btn px-3 py-1.5 rounded text-xs" style={{ background: lf.useCustom ? "var(--brass)" : "var(--paper-card)", color: lf.useCustom ? "#fff" : "var(--ink)", borderColor: lf.useCustom ? "var(--brass)" : "var(--ink)" }}>Custom</button>
          {lf.useCustom && <input type="number" placeholder="Price/lb" value={lf.custom} onChange={(e) => setLf({ ...lf, custom: e.target.value })} className="px-2 py-1.5 w-28 mono text-sm" />}
          {selectedItem && <span className="mono text-sm ml-auto" style={{ color: "var(--brass)" }}>→ {money(previewPrice)}/lb</span>}
          <button onClick={addLine} className="tag-btn tag-btn-primary px-4 py-2 rounded flex items-center justify-center gap-1"><Plus size={16} /> Add</button>
        </div>
        {items.length === 0 && <p className="text-sm mt-2" style={{ color: "var(--oxblood)" }}>No items in inventory yet.</p>}
      </section>

      {lines.length > 0 && (
        <section style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }} className="rounded p-4 sm:p-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left py-2 pr-3">Item</th>
                  <th className="text-right py-2 pr-3">Qty lb</th>
                  <th className="text-right py-2 pr-3">Tier</th>
                  <th className="text-right py-2 pr-3">Price/lb</th>
                  <th className="text-right py-2 pr-3">Line total</th>
                  {role === "manager" && <th className="text-right py-2 pr-3">Margin %</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const lineTotal = l.qty * l.price;
                  const lm = lineTotal - l.qty * l.cost;
                  const lmPct = lineTotal > 0 ? (lm / lineTotal) * 100 : 0;
                  return (
                    <Fragment key={l.id}>
                      <tr>
                        <td className="py-2 pr-3">{l.itemName}</td>
                        <td className="text-right py-2 pr-3 mono">{lb(l.qty)}</td>
                        <td className="text-right py-2 pr-3 mono">{l.tier ? `${l.tier}%` : "custom"}</td>
                        <td className="text-right py-2 pr-3 mono">{money(l.price)}</td>
                        <td className="text-right py-2 pr-3 mono">{money(lineTotal)}</td>
                        {role === "manager" && <td className="text-right py-2 pr-3 mono" style={{ color: lmPct < 0 ? "var(--oxblood)" : "var(--green)", fontWeight: 600 }}>{pct(lmPct)}</td>}
                        <td className="text-right py-2"><button onClick={() => removeLine(l.id)} style={{ color: "var(--ink-soft)" }}><Trash2 size={14} /></button></td>
                      </tr>
                      <tr>
                        <td colSpan={role === "manager" ? 7 : 6} className="pb-2 pr-3" style={{ borderBottom: "1px solid var(--line)" }}>
                          <input
                            value={l.comment || ""}
                            onChange={(e) => updateLineComment(l.id, e.target.value)}
                            placeholder="Comment for this item (e.g. cut into 1lb portions, bone-in)…"
                            className="px-2 py-1 w-full text-xs"
                            style={{ background: "#fff" }}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ borderTop: "1.5px solid var(--ink)" }} className="mt-4 pt-4 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div className="flex gap-6 mono text-sm">
              <div><div style={{ color: "var(--ink-soft)" }}>Subtotal</div><div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{money(subtotal)}</div></div>
              {role === "manager" && <div><div style={{ color: "var(--ink-soft)" }}>Total cost</div><div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{money(totalCost)}</div></div>}
              {role === "manager" && <div><div style={{ color: "var(--ink-soft)" }}>Margin</div><div style={{ fontSize: "1.1rem", fontWeight: 700, color: marginDollar < 0 ? "var(--oxblood)" : "var(--green)" }}>{money(marginDollar)} ({pct(marginPct)})</div></div>}
            </div>
            <button onClick={handleSave} disabled={!customerId || saving} className="tag-btn tag-btn-primary px-5 py-2.5 rounded flex items-center justify-center gap-2 disabled:opacity-40">
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Save order & generate invoice
            </button>
          </div>
          {savedMsg && <p className="text-sm mt-2" style={{ color: "var(--green)" }}>{savedMsg}</p>}
        </section>
      )}
    </div>
  );
}

// ---------- Orders & Invoices ----------
function OrdersView({ orders, onMarkExported, onToggleStage, onDelete, role }) {
  const [expanded, setExpanded] = useState({});
  const unexported = orders.filter((o) => !o.exported);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>CSV columns match a standard QuickBooks Online invoice import — map them in QBO's import tool on first use.</p>
        {unexported.length > 0 && (
          <button onClick={() => downloadText(`invoices-batch-${todayISO()}.csv`, ordersToCSV(unexported))} className="tag-btn tag-btn-primary px-4 py-2 rounded flex items-center justify-center gap-2 whitespace-nowrap">
            <FileDown size={16} /> Export {unexported.length} unexported
          </button>
        )}
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-10" style={{ color: "var(--ink-soft)" }}><Receipt size={28} className="mx-auto mb-2" />No orders saved yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ background: "var(--paper-card)", border: "1.5px solid var(--ink)" }}>
            <thead>
              <tr>
                <th className="text-left py-2 px-3">Invoice</th><th className="text-left py-2 px-3">Date</th><th className="text-left py-2 px-3">Customer</th>
                <th className="text-right py-2 px-3">Total</th>{role === "manager" && <th className="text-right py-2 px-3">Margin</th>}
                <th className="text-left py-2 px-3">Checklist</th><th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const stages = o.stages || { received: false, entered: false, fulfilled: false, invoiced: false };
                const complete = ORDER_STAGES.every((s) => stages[s.key]);
                const isOpen = expanded[o.id];
                return (
                  <Fragment key={o.id}>
                    <tr>
                      <td className="py-2 px-3">
                        <button onClick={() => setExpanded((e) => ({ ...e, [o.id]: !isOpen }))} className="flex items-center gap-1 mono">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {o.invoiceNo}
                        </button>
                      </td>
                      <td className="py-2 px-3 mono">{o.date}</td>
                      <td className="py-2 px-3">{o.customerName}</td>
                      <td className="text-right py-2 px-3 mono">{money(o.subtotal)}</td>
                      {role === "manager" && <td className="text-right py-2 px-3 mono" style={{ color: o.marginDollar < 0 ? "var(--oxblood)" : "var(--green)" }}>{money(o.marginDollar)} ({pct(o.marginPct)})</td>}
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {complete && <CheckCircle2 size={16} color="var(--green)" title="Order chain complete" />}
                          {ORDER_STAGES.map((s) => (
                            <button
                              key={s.key}
                              onClick={() => onToggleStage(o, s.key)}
                              title={s.label}
                              className="stamp flex items-center gap-1"
                              style={{ color: stages[s.key] ? "var(--green)" : "var(--ink-soft)", borderColor: stages[s.key] ? "var(--green)" : "var(--line)", cursor: "pointer" }}
                            >
                              {stages[s.key] ? <CheckCircle2 size={11} /> : <Circle size={11} />} {s.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => { downloadText(`${o.invoiceNo}.csv`, orderCSV(o)); onMarkExported(o); }} title="Download invoice CSV" style={{ color: "var(--ink)" }}><Download size={15} /></button>
                          {role === "manager" && <button onClick={() => onDelete(o.id)} title="Delete order" style={{ color: "var(--oxblood)" }}><Trash2 size={14} /></button>}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={role === "manager" ? 7 : 6} className="p-3" style={{ background: "#fff" }}>
                          <table className="w-full text-xs">
                            <thead>
                              <tr>
                                <th className="text-left py-1 pr-3">Item</th>
                                <th className="text-right py-1 pr-3">Qty lb</th>
                                <th className="text-right py-1 pr-3">Price/lb</th>
                                <th className="text-right py-1 pr-3">Line total</th>
                                <th className="text-left py-1">Comment</th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.lines.map((l) => (
                                <tr key={l.id}>
                                  <td className="py-1 pr-3">{l.itemName}</td>
                                  <td className="text-right py-1 pr-3 mono">{lb(l.qty)}</td>
                                  <td className="text-right py-1 pr-3 mono">{money(l.price)}</td>
                                  <td className="text-right py-1 pr-3 mono">{money(l.qty * l.price)}</td>
                                  <td className="py-1" style={{ color: l.comment ? "var(--ink)" : "var(--ink-soft)" }}>
                                    {l.comment ? <span className="flex items-center gap-1"><MessageSquare size={11} />{l.comment}</span> : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
